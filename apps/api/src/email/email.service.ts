import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

interface WeeklyDigest {
  workspaceId: string;
  period: { start: string; end: string };
  stats: {
    totalCalls: number;
    totalMinutes: number;
    avgDuration: number;
    blockedRate: number;
  };
  complianceAlerts: Array<{ reason: string; count: number }>;
  upcomingCampaigns: Array<{ name: string; scheduledCalls: number }>;
}

/**
 * Why the digest is only sent to owners/admins: it aggregates workspace-wide
 * call volume and compliance posture, which is management-level information.
 * Editors and viewers are intentionally excluded.
 */
const DIGEST_RECIPIENT_ROLES = ['owner', 'admin'] as const;

export type WeeklyDigestSkipReason =
  | 'email_not_configured'
  | 'workspace_not_found'
  | 'no_recipients';

export type WeeklyDigestResult =
  | { status: 'skipped'; reason: WeeklyDigestSkipReason; sent: 0; failed: 0 }
  | { status: 'sent'; sent: number; failed: number };

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sendInvite(params: {
    to: string;
    inviterName: string;
    workspaceName: string;
    role: string;
    acceptUrl: string;
    expiresAt: Date;
  }): Promise<{ delivered: boolean }> {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('[EmailService] RESEND_API_KEY not set — skipping email');
      return { delivered: false };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #18181b;">You've been invited to ${params.workspaceName}</h2>
  <p>${params.inviterName} invited you as <strong>${params.role}</strong>.</p>
  <a href="${params.acceptUrl}" style="display:inline-block;background:#10b981;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0;">Accept Invite</a>
  <p style="color:#71717a;font-size:14px;">Expires: ${params.expiresAt.toLocaleDateString()}</p>
</body></html>`;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM ?? 'VoiceForge <noreply@voiceforge.ai>',
          to: params.to,
          subject: `You've been invited to ${params.workspaceName}`,
          html,
        }),
      });
      return { delivered: res.ok };
    } catch (e) {
      console.error('[EmailService] sendInvite failed', e);
      return { delivered: false };
    }
  }

  async send(params: { to: string; subject: string; html: string; text?: string }): Promise<void> {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) {
      this.logger.warn('[EmailService.send] RESEND_API_KEY not set — skipping email');
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'noreply@' + (env.WEB_BASE_URL?.replace('https://', '') || 'localhost'),
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`[EmailService.send] Resend error: ${err}`);
      throw new Error(`Failed to send email: ${err}`);
    }
  }

  async buildWeeklyDigest(workspaceId: string): Promise<WeeklyDigest> {
    const periodStart = this.getWeekStart();
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + 7);

    const [calls, complianceBlocked, campaigns] = await Promise.all([
      this.prisma.call.findMany({
        where: { workspaceId, createdAt: { gte: periodStart, lt: periodEnd } },
        select: { durationSeconds: true },
      }),
      this.prisma.complianceCheck.findMany({
        where: { workspaceId, checkedAt: { gte: periodStart, lt: periodEnd }, status: 'blocked' },
        select: { reasons: true },
      }),
      this.prisma.outboundCampaign.findMany({
        where: { workspaceId, status: { in: ['draft', 'running'] }, createdAt: { lt: periodEnd } },
        select: { name: true, contacts: true },
      }),
    ]);

    const totalCalls = calls.length;
    const totalMinutes = calls.reduce((s, c) => s + (c.durationSeconds ?? 0), 0) / 60;
    const avgDuration = totalCalls > 0 ? totalMinutes / totalCalls : 0;
    const blockedCount = complianceBlocked.length;
    const blockedRate = totalCalls + blockedCount > 0 ? blockedCount / (totalCalls + blockedCount) : 0;

    const reasonCounts = new Map<string, number>();
    for (const check of complianceBlocked) {
      const reasons = (check.reasons as Array<{ code: string }>) ?? [];
      for (const reason of reasons) {
        reasonCounts.set(reason.code, (reasonCounts.get(reason.code) ?? 0) + 1);
      }
    }
    const complianceAlerts = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    const upcomingCampaigns = campaigns.map((c) => ({
      name: c.name,
      scheduledCalls: ((c.contacts as unknown as Array<unknown>) ?? []).length,
    }));

    return {
      workspaceId,
      period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
      stats: { totalCalls, totalMinutes, avgDuration, blockedRate },
      complianceAlerts,
      upcomingCampaigns,
    };
  }

  /**
   * Build and deliver the weekly digest to the workspace's owners/admins.
   *
   * Failure behaviour is deliberately non-throwing: this runs from a scheduled
   * job, and one workspace's misconfigured mailbox must not abort the run for
   * every other workspace. Per-recipient failures are counted and logged.
   */
  async sendWeeklyDigest(workspaceId: string): Promise<WeeklyDigestResult> {
    if (!env.RESEND_API_KEY) {
      this.logger.warn(
        `[WeeklyDigest] RESEND_API_KEY not set — skipping digest for workspace ${workspaceId}`,
      );
      return { status: 'skipped', reason: 'email_not_configured', sent: 0, failed: 0 };
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) {
      this.logger.warn(`[WeeklyDigest] Workspace ${workspaceId} not found — skipping digest`);
      return { status: 'skipped', reason: 'workspace_not_found', sent: 0, failed: 0 };
    }

    const recipients = await this.resolveDigestRecipients(workspaceId);
    if (recipients.length === 0) {
      this.logger.warn(
        `[WeeklyDigest] No owner/admin recipients for workspace ${workspaceId} — skipping digest`,
      );
      return { status: 'skipped', reason: 'no_recipients', sent: 0, failed: 0 };
    }

    const digest = await this.buildWeeklyDigest(workspaceId);
    const subject = `VoiceForge weekly digest — ${workspace.name}`;
    const html = this.renderDigestHtml(workspace.name, digest);
    const text = this.renderDigestText(workspace.name, digest);

    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      try {
        await this.send({ to, subject, html, text });
        sent += 1;
      } catch (err) {
        failed += 1;
        // Log the address, never the Resend key or full response body.
        this.logger.error(
          `[WeeklyDigest] Delivery failed for workspace ${workspaceId} recipient ${to}: ${
            (err as Error).message
          }`,
        );
      }
    }

    this.logger.log(
      `[WeeklyDigest] Workspace ${workspaceId}: ${digest.stats.totalCalls} calls, ` +
      `${digest.stats.totalMinutes.toFixed(1)} min, blocked ${(digest.stats.blockedRate * 100).toFixed(1)}% ` +
      `— delivered ${sent}/${recipients.length}`,
    );

    return { status: 'sent', sent, failed };
  }

  /**
   * Owners/admins of this workspace only. The membership query is the tenancy
   * boundary: recipients are never derived from the organization or from a
   * parent workspace, so a digest cannot leak to a sibling tenant.
   */
  private async resolveDigestRecipients(workspaceId: string): Promise<string[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId, role: { in: [...DIGEST_RECIPIENT_ROLES] } },
      select: { user: { select: { email: true } } },
    });

    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const membership of memberships) {
      const email = membership.user?.email?.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push(email);
    }
    return recipients;
  }

  private renderDigestHtml(workspaceName: string, digest: WeeklyDigest): string {
    const esc = (v: string) => this.escapeHtml(v);
    const period = `${this.formatDate(digest.period.start)} – ${this.formatDate(digest.period.end)}`;

    const alertRows = digest.complianceAlerts.length
      ? digest.complianceAlerts
          .map(
            (a) =>
              `<li style="margin-bottom:4px;">${esc(a.reason)} — <strong>${a.count}</strong></li>`,
          )
          .join('')
      : '<li style="color:#71717a;">No compliance blocks this week.</li>';

    const campaignRows = digest.upcomingCampaigns.length
      ? digest.upcomingCampaigns
          .map(
            (c) =>
              `<li style="margin-bottom:4px;">${esc(c.name)} — <strong>${c.scheduledCalls}</strong> scheduled calls</li>`,
          )
          .join('')
      : '<li style="color:#71717a;">No active or draft campaigns.</li>';

    const stat = (label: string, value: string) =>
      `<td style="padding:12px 16px;border:1px solid #e4e4e7;border-radius:6px;">
        <div style="color:#71717a;font-size:12px;text-transform:uppercase;">${esc(label)}</div>
        <div style="color:#18181b;font-size:20px;font-weight:600;">${esc(value)}</div>
      </td>`;

    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="color:#18181b;margin-bottom:4px;">Weekly digest — ${esc(workspaceName)}</h2>
  <p style="color:#71717a;margin-top:0;">${esc(period)}</p>
  <table style="border-collapse:separate;border-spacing:8px 0;width:100%;"><tr>
    ${stat('Calls', String(digest.stats.totalCalls))}
    ${stat('Minutes', digest.stats.totalMinutes.toFixed(1))}
    ${stat('Avg duration', `${digest.stats.avgDuration.toFixed(1)} min`)}
    ${stat('Blocked', `${(digest.stats.blockedRate * 100).toFixed(1)}%`)}
  </tr></table>
  <h3 style="color:#18181b;margin-top:24px;">Compliance alerts</h3>
  <ul style="padding-left:20px;">${alertRows}</ul>
  <h3 style="color:#18181b;margin-top:24px;">Upcoming campaigns</h3>
  <ul style="padding-left:20px;">${campaignRows}</ul>
  <p style="color:#71717a;font-size:12px;margin-top:24px;">
    You receive this because you are an owner or admin of ${esc(workspaceName)}.
  </p>
</body></html>`;
  }

  private renderDigestText(workspaceName: string, digest: WeeklyDigest): string {
    const lines = [
      `Weekly digest - ${workspaceName}`,
      `${this.formatDate(digest.period.start)} - ${this.formatDate(digest.period.end)}`,
      '',
      `Calls: ${digest.stats.totalCalls}`,
      `Minutes: ${digest.stats.totalMinutes.toFixed(1)}`,
      `Avg duration: ${digest.stats.avgDuration.toFixed(1)} min`,
      `Blocked rate: ${(digest.stats.blockedRate * 100).toFixed(1)}%`,
      '',
      'Compliance alerts:',
      ...(digest.complianceAlerts.length
        ? digest.complianceAlerts.map((a) => `  - ${a.reason}: ${a.count}`)
        : ['  - No compliance blocks this week.']),
      '',
      'Upcoming campaigns:',
      ...(digest.upcomingCampaigns.length
        ? digest.upcomingCampaigns.map((c) => `  - ${c.name}: ${c.scheduledCalls} scheduled calls`)
        : ['  - No active or draft campaigns.']),
      '',
      `You receive this because you are an owner or admin of ${workspaceName}.`,
    ];
    return lines.join('\n');
  }

  private formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private getWeekStart(): Date {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday;
  }
}