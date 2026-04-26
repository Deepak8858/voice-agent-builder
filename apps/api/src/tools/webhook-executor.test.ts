import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { WebhookExecutor } from './webhook-executor';

describe('WebhookExecutor', () => {
  const exec = new WebhookExecutor();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('POSTs JSON and returns parsed body + status + duration', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, n: 1 }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as never;

    vi.useRealTimers();
    const result = await exec.execute(
      { url: 'https://example.test/hook', method: 'POST', timeout_ms: 1000 } as never,
      { hello: 'world' },
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, n: 1 });
    expect(typeof result.duration_ms).toBe('number');
    const callArg = (fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(callArg.method).toBe('POST');
    expect(JSON.parse(callArg.body as string)).toEqual({ hello: 'world' });
    const headers = callArg.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-voiceforge-signature']).toBeUndefined();
  });

  it('signs body with HMAC-SHA256 when secret is set', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as never;

    vi.useRealTimers();
    await exec.execute(
      {
        url: 'https://example.test/hook',
        method: 'POST',
        hmac_secret: 'topsecret',
        timeout_ms: 1000,
      } as never,
      { foo: 'bar' },
    );

    const callArg = (fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    const body = callArg.body as string;
    const headers = callArg.headers as Record<string, string>;
    const expected = `sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`;
    expect(headers['x-voiceforge-signature']).toBe(expected);
  });

  it('returns string body when response is non-JSON text', async () => {
    globalThis.fetch = (async () => new Response('plain text', { status: 200 })) as never;
    vi.useRealTimers();
    const result = await exec.execute(
      { url: 'https://example.test/x', method: 'POST', timeout_ms: 1000 } as never,
      {},
    );
    expect(result.body).toBe('plain text');
  });

  it('truncates very long text bodies', async () => {
    const big = 'x'.repeat(8192);
    globalThis.fetch = (async () => new Response(big, { status: 200 })) as never;
    vi.useRealTimers();
    const result = await exec.execute(
      { url: 'https://example.test/x', method: 'POST', timeout_ms: 1000 } as never,
      {},
    );
    expect((result.body as string).length).toBeLessThanOrEqual(4097);
    expect((result.body as string).endsWith('…')).toBe(true);
  });

  it('GET method does not send body or signature', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as never;
    vi.useRealTimers();
    await exec.execute(
      {
        url: 'https://example.test/x',
        method: 'GET',
        hmac_secret: 'sek',
        timeout_ms: 1000,
      } as never,
      { ignored: true },
    );
    const callArg = (fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(callArg.body).toBeUndefined();
    expect((callArg.headers as Record<string, string>)['x-voiceforge-signature']).toBeUndefined();
  });
});
