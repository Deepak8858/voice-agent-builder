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
}