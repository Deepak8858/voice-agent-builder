import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function contextForUrl(url: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: url }),
    }),
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

  it('leaves Prometheus metrics responses unwrapped', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    const metrics = '# HELP voiceforge_test metric\nvoiceforge_test 1\n';

    await expect(lastValueFrom(interceptor.intercept(
      contextForUrl('/api/v1/metrics'),
      handlerReturning(metrics),
    ))).resolves.toBe(metrics);
  });
});
