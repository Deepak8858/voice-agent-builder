import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { WebhookConfig } from '@voiceforge/shared';
import type { ToolExecutor, ToolCallResult } from './tools.service';

@Injectable()
export class WebhookExecutor implements ToolExecutor {
  readonly name = 'webhook';

  /**
   * Posts the payload to the configured URL. When `hmac_secret` is set, signs
   * the JSON body with HMAC-SHA256 and sends the signature in
   * `X-VoiceForge-Signature: sha256=<hex>`. Caller is responsible for catching
   * exceptions — this method does not retry.
   */
  async execute(params: Record<string, unknown>, config: Record<string, string>): Promise<ToolCallResult> {
    const webhookConfig = config as unknown as WebhookConfig;
    const method = webhookConfig.method ?? 'POST';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'VoiceForge-Webhook/1.0',
      ...(webhookConfig.headers ?? {}),
    };

    let body: string | undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      body = JSON.stringify(params ?? {});
      if (webhookConfig.hmac_secret) {
        const signature = createHmac('sha256', webhookConfig.hmac_secret).update(body).digest('hex');
        headers['x-voiceforge-signature'] = `sha256=${signature}`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhookConfig.timeout_ms ?? 10_000);

    const t = Date.now();
    try {
      const res = await fetch(webhookConfig.url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const duration_ms = Date.now() - t;
      const text = await res.text();
      const parsed = this.tryJson(text);
      return { success: res.ok, result: { status: res.status, body: parsed, duration_ms } };
    } finally {
      clearTimeout(timeout);
    }
  }

  private tryJson(text: string): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text.length > 4096 ? text.slice(0, 4096) + '…' : text;
    }
  }
}
