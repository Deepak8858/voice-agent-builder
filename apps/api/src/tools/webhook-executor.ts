import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { ToolExecutor, ToolCallResult } from './tools.service';

interface WebhookExecutorConfig {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  hmac_secret?: string;
  timeout_ms?: number;
}

@Injectable()
export class WebhookExecutor implements ToolExecutor {
  readonly name = 'webhook';

  /**
   * Posts the payload to the configured URL. When `hmac_secret` is set, signs
   * the JSON body with HMAC-SHA256 and sends the signature in
   * `X-VoiceForge-Signature: sha256=<hex>`.
   *
   * Returns a `ToolCallResult` with `success=true` for HTTP 2xx, `success=false`
   * with an `error` message otherwise. Network errors surface via thrown
   * exceptions caught by the calling ToolsService.
   */
  async execute(
    params: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const cfg = config as unknown as WebhookExecutorConfig;
    if (!cfg.url) {
      return { success: false, error: 'webhook tool config missing url' };
    }
    const method = cfg.method ?? 'POST';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'VoiceForge-Webhook/1.0',
      ...(cfg.headers ?? {}),
    };

    let body: string | undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      body = JSON.stringify(params ?? {});
      if (cfg.hmac_secret) {
        const signature = createHmac('sha256', cfg.hmac_secret).update(body).digest('hex');
        headers['x-voiceforge-signature'] = `sha256=${signature}`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeout_ms ?? 10_000);

    const t = Date.now();
    try {
      const res = await fetch(cfg.url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const duration_ms = Date.now() - t;
      const text = await res.text();
      const parsed = this.tryJson(text);
      if (res.status >= 200 && res.status < 300) {
        return { success: true, result: { status: res.status, body: parsed, duration_ms } };
      }
      return {
        success: false,
        error: `HTTP ${res.status}`,
        result: { status: res.status, body: parsed, duration_ms },
      };
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
