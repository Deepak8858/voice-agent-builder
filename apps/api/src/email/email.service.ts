import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

export interface SendInviteEmailInput {
  to: string;
  inviteToken: string;
  role: string;
  brandName?: string | null;
  brandLogoUrl?: string | null;
  primaryColor?: string | null;
  inviterName?: string | null;
  expiresAt: Date;
}

export interface SendEmailResult {
  delivered: boolean;
  id?: string;
  reason?: string;
}

interface ResendApiResponse {
  id?: string;
  message?: string;
  name?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  isConfigured(): boolean {
    return Boolean(env.RESEND_API_KEY);
  }

  /**
   * Sends a transactional email via the Resend API. If RESEND_API_KEY is not
   * configured, logs a warning and returns `{ delivered: false }` so callers
   * can fall back to surfacing the invite token in the response.
   */
  async sendInvite(input: SendInviteEmailInput): Promise<SendEmailResult> {
    if (!env.RESEND_API_KEY) {
      this.logger.warn(
        `RESEND_API_KEY not configured; skipping invite email to ${input.to}.`,
      );
      return { delivered: false, reason: 'not_configured' };
    }

    const acceptUrl = `${env.WEB_BASE_URL.replace(/\/$/, '')}/invite/accept?token=${encodeURIComponent(input.inviteToken)}`;
    const brand = input.brandName ?? 'VoiceForge';
    const color = input.primaryColor ?? '#10b981';
    const subject = `${brand} invited you to collaborate`;
    const html = renderInviteHtml({
      brand,
      color,
      logoUrl: input.brandLogoUrl ?? null,
      inviterName: input.inviterName ?? null,
      role: input.role,
      acceptUrl,
      expiresAt: input.expiresAt,
    });

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: input.to,
          subject,
          html,
        }),
      });
      const payload = (await res.json().catch(() => null)) as ResendApiResponse | null;
      if (!res.ok) {
        const reason = payload?.message ?? `HTTP ${res.status}`;
        this.logger.error(`Resend send failed: ${reason}`);
        return { delivered: false, reason };
      }
      return { delivered: true, id: payload?.id };
    } catch (err) {
      this.logger.error(`Resend network error: ${(err as Error).message}`);
      return { delivered: false, reason: (err as Error).message };
    }
  }
}

interface InviteTemplate {
  brand: string;
  color: string;
  logoUrl: string | null;
  inviterName: string | null;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}

function renderInviteHtml(t: InviteTemplate): string {
  const expiry = t.expiresAt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const inviterLine = t.inviterName ? `${t.inviterName} invited you` : `You were invited`;
  const logo = t.logoUrl
    ? `<img src="${t.logoUrl}" alt="${escapeHtml(t.brand)}" style="max-width:160px;height:auto;margin-bottom:24px;" />`
    : `<div style="font-size:24px;font-weight:600;color:${t.color};margin-bottom:24px;">${escapeHtml(t.brand)}</div>`;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      ${logo}
      <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;">${inviterLine} to ${escapeHtml(t.brand)}.</h1>
      <p style="margin:0 0 24px 0;font-size:14px;line-height:1.5;color:#4b5563;">
        You've been invited to join as <strong>${escapeHtml(t.role)}</strong>. Click the button below to accept and create your account.
      </p>
      <a href="${t.acceptUrl}" style="display:inline-block;background:${t.color};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px;">Accept invitation</a>
      <p style="margin:24px 0 0 0;font-size:12px;color:#6b7280;">
        This invite expires on ${expiry}. If the button doesn't work, paste this link into your browser:<br />
        <span style="word-break:break-all;">${t.acceptUrl}</span>
      </p>
    </div>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
