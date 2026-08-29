import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { RequestLoggingMiddleware } from './request-logging.middleware';
import { logger } from '../logging';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(headerValue?: string | string[], originalUrl = '/api/v1/health') {
  const req = {
    method: 'GET',
    originalUrl,
    headers: headerValue === undefined ? {} : { 'x-request-id': headerValue },
    ip: '203.0.113.7',
  } as unknown as Request;

  const setHeader = vi.fn();
  // Fire the `finish` handler synchronously so the request:end record is
  // produced too — it is a second, independent log call site.
  const res = {
    setHeader,
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'finish') cb();
    }),
    statusCode: 200,
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  new RequestLoggingMiddleware().use(req, res, next);

  return {
    correlationId: ((req as unknown) as Record<string, unknown>).correlationId as string,
    setHeader,
    next,
  };
}

describe('RequestLoggingMiddleware correlation ID', () => {
  it('generates a UUID when no header is supplied', () => {
    const { correlationId, setHeader, next } = run();

    expect(correlationId).toMatch(UUID_SHAPE);
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', correlationId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('reuses a well-formed upstream ID so proxy traces survive', () => {
    const upstream = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

    expect(run(upstream).correlationId).toBe(upstream);
  });

  it('replaces caller-controlled values that are not opaque IDs', () => {
    // The correlation ID is echoed in the X-Request-ID response header, written
    // to structured logs and sent to error tracking as a distinct ID, so free
    // text from the caller must never be carried through verbatim.
    const hostile = [
      'not a plain id',
      'id\r\nX-Injected: 1',
      '{"$ne":null}',
      '<script>alert(1)</script>',
      'a'.repeat(129),
      '',
    ];

    for (const value of hostile) {
      expect(run(value).correlationId).toMatch(UUID_SHAPE);
    }
  });

  it('replaces a repeated header, which Express joins into one string', () => {
    // Express collapses duplicates to `first, second`; the comma and space fail
    // the pattern, so a fresh server-owned ID is minted.
    expect(run(['first', 'second']).correlationId).toMatch(UUID_SHAPE);
  });
});

describe('RequestLoggingMiddleware URL logging', () => {
  it('strips the query string from every logged URL', () => {
    // The Google OAuth callback takes its one-time `code` as a query parameter
    // and the web proxy forwards the search string verbatim, so logging the
    // query persists a live credential to the log store. pino's `redact` cannot
    // cover this: the value is a hand-picked scalar on the merging object.
    const info = vi.spyOn(logger, 'info').mockImplementation((() => undefined) as never);

    try {
      run(undefined, '/api/v1/google/callback?code=4%2F0Aeaeaeaeaea&state=xyz');

      const urls = info.mock.calls.map(([record]) => (record as { url: string }).url);

      expect(urls).toEqual(['/api/v1/google/callback', '/api/v1/google/callback']);
    } finally {
      info.mockRestore();
    }
  });
});
