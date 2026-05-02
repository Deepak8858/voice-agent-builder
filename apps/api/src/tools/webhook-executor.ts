import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { WebhookConfig } from '@voiceforge/shared';
import type { ToolExecutor, ToolCallResult } from './tools.service';

export interface WebhookExecutionResult {
  status: number;
  body: unknown;
  duration_ms: number;
}

@Injectable()
export class WebhookExecutor implements ToolExecutor {
  readonly name = 'webhook';

  /**
   * Posts the payload to the configured URL. When `hmac_secret` is set, signs
   * the JSON body with HMAC-SHA256 and sends the signature in
   * `X-VoiceForge-Signature: sha256=<hex>`. Caller is responsible for catching
   * exceptions — this method does not retry.
   */
  async execute(config: WebhookConfig, payload: unknown): Promise<WebhookExecutionResult> {
    const method = config.method ?? 'POST';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'VoiceForge-Webhook/1.0',
      ...(config.headers ?? {}),
    };

    let body: string | undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      body = JSON.stringify(payload ?? {});
      if (config.hmac_secret) {
        const signature = createHmac('sha256', config.hmac_secret).update(body).digest('hex');
        headers['x-voiceforge-signature'] = `sha256=${signature}`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? 10_000);

    const t = Date.now();
    try {
      const res = await fetch(config.url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const duration_ms = Date.now() - t;
      const text = await res.text();
      const parsed = this.tryJson(text);
      return { status: res.status, body: parsed, duration_ms };
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
