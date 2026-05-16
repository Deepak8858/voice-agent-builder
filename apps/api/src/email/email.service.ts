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

  async sendWeeklyDigest(workspaceId: string): Promise<void> {
    const digest = await this.buildWeeklyDigest(workspaceId);
    this.logger.log(
      `[WeeklyDigest] Workspace ${workspaceId}: ${digest.stats.totalCalls} calls, ` +
      `${digest.stats.totalMinutes.toFixed(1)} min, blocked ${(digest.stats.blockedRate * 100).toFixed(1)}%`,
    );
    // TODO: integrate Resend/SendGrid for full email delivery.
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