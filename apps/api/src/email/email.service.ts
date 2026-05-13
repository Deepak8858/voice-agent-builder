import { Injectable } from '@nestjs/common';
import { env } from '../config/env';

@Injectable()
export class EmailService {
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

  async sendOverageAlert(params: {
    to: string;
    orgName: string;
    type: 'warning' | 'at_limit';
    percentage: number;
    calls: { used: number; limit: number };
    minutes: { used: number; limit: number };
  }): Promise<{ delivered: boolean }> {
    const { to, orgName, type, percentage, calls, minutes } = params;
    const subject = type === 'at_limit'
      ? `⚠️ ${orgName}: Voice minute limit reached`
      : `⚠️ ${orgName}: ${percentage}% of voice minutes used`;

    const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${type === 'at_limit' ? 'Limit Reached' : 'Usage Warning'}</h2>
      <p>Hi,</p>
      <p>Your VoiceForge organization <strong>${orgName}</strong> has used <strong>${percentage}%</strong> of its ${type === 'at_limit' ? 'monthly voice minute limit' : 'plan allowance'}.</p>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px;">Calls</td><td style="padding: 8px;">${calls.used} / ${calls.limit === -1 ? '∞' : calls.limit}</td></tr>
        <tr><td style="padding: 8px;">Minutes</td><td style="padding: 8px;">${minutes.used} / ${minutes.limit === -1 ? '∞' : minutes.limit}</td></tr>
      </table>
      ${type === 'warning' ? '<p>Consider upgrading to avoid service interruption.</p>' : '<p>Your account has been temporarily restricted. Upgrade to restore service.</p>'}
    </div>
  `;

    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('[EmailService] RESEND_API_KEY not set — skipping overage alert');
      return { delivered: false };
    }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM ?? 'VoiceForge <noreply@voiceforge.ai>',
          to,
          subject,
          html,
          text: `Usage update for ${orgName}: ${percentage}% used`,
        }),
      });
      return { delivered: res.ok };
    } catch (e) {
      console.error('[EmailService] sendOverageAlert failed', e);
      return { delivered: false };
    }
  }
}