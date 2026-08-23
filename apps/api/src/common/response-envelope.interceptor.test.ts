import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';
import { SKIP_RESPONSE_ENVELOPE_KEY } from './decorators/skip-response-envelope.decorator';

function contextForUrl(
  url: string,
  handler: object = {},
  controller: object = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: url }),
    }),
    getHandler: () => handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

function handlerReturning(data: unknown): CallHandler {
  return {
    handle: () => of(data),
  };
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps ordinary API responses', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();

    await expect(lastValueFrom(interceptor.intercept(
      contextForUrl('/api/v1/health'),
      handlerReturning({ status: 'healthy' }),
    ))).resolves.toEqual({
      success: true,
      data: { status: 'healthy' },
      error: null,
    });
  });

  it('leaves explicitly marked provider responses unwrapped', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    const handler = {};
    Reflect.defineMetadata(SKIP_RESPONSE_ENVELOPE_KEY, true, handler);
    const response = { results: [{ toolCallId: 'tc-1', result: '{"ok":true}' }] };

    await expect(lastValueFrom(interceptor.intercept(
      contextForUrl('/api/v1/voice/webhooks/livekit/agents/a1/tools', handler),
      handlerReturning(response),
    ))).resolves.toBe(response);
  });

  it('leaves Prometheus metrics responses unwrapped', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    const metrics = '# HELP voiceforge_test metric\nvoiceforge_test 1\n';

    await expect(lastValueFrom(interceptor.intercept(
      contextForUrl('/api/v1/metrics'),
      handlerReturning(metrics),
    ))).resolves.toBe(metrics);
  });
});
