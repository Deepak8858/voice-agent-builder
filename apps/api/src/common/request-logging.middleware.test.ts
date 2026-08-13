import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { RequestLoggingMiddleware } from './request-logging.middleware';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(headerValue?: string | string[]) {
  const req = {
    method: 'GET',
    originalUrl: '/api/v1/health',
    headers: headerValue === undefined ? {} : { 'x-request-id': headerValue },
    ip: '203.0.113.7',
  } as unknown as Request;

  const setHeader = vi.fn();
  const res = { setHeader, on: vi.fn(), statusCode: 200 } as unknown as Response;
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
