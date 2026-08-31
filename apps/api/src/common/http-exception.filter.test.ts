import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CORRELATION_ID = 'corr-1234';

interface CapturedException {
  error: unknown;
  correlationId?: string | undefined;
  properties?: Record<string, unknown> | undefined;
}

/**
 * Stands in for `PostHogService`. Only `captureException` is exercised, so the
 * fake is cast at the call site rather than implementing the whole service.
 */
function makePosthog() {
  const exceptions: CapturedException[] = [];
  return {
    exceptions,
    captureException(
      error: unknown,
      correlationId?: string,
      properties?: Record<string, unknown>,
    ) {
      exceptions.push({ error, correlationId, properties });
    },
  };
}

interface HostResult {
  host: ArgumentsHost;
  status: () => number | undefined;
  body: () => unknown;
  headers: Record<string, string>;
}

function makeHost(options: { route?: string } = {}): HostResult {
  let sentStatus: number | undefined;
  let sentBody: unknown;
  const headers: Record<string, string> = {};

  const req = {
    method: 'POST',
    url: '/api/v1/agents/44444444-4444-4444-4444-444444444444',
    correlationId: CORRELATION_ID,
    ...(options.route ? { route: { path: options.route } } : {}),
  };

  const res = {
    status(code: number) {
      sentStatus = code;
      return res;
    },
    json(body: unknown) {
      sentBody = body;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;

  return { host, status: () => sentStatus, body: () => sentBody, headers };
}

/**
 * `src/config/env.ts` parses `process.env` once at module load, so the flag
 * cannot be changed on an already-imported filter. Each case re-imports the
 * module graph under a stubbed environment.
 */
async function loadFilter(captureClientErrors: boolean) {
  vi.stubEnv('POSTHOG_CAPTURE_CLIENT_ERRORS', captureClientErrors ? 'true' : 'false');
  vi.resetModules();
  const { HttpExceptionFilter } = await import('./http-exception.filter');
  return HttpExceptionFilter;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('HttpExceptionFilter capture matrix', () => {
  it('captures a 5xx HttpException', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);
    const { host, status } = makeHost();

    // The regression this guards: a deliberately thrown 500 is an
    // `HttpException`, which the previous implementation skipped entirely.
    filter.catch(new InternalServerErrorException('database unreachable'), host);

    expect(status()).toBe(500);
    expect(posthog.exceptions).toHaveLength(1);
    expect(posthog.exceptions[0]!.correlationId).toBe(CORRELATION_ID);
    expect(posthog.exceptions[0]!.properties?.status_code).toBe(500);
  });

  it('captures an unexpected non-HttpException error as a 500', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);
    const { host, status } = makeHost();

    filter.catch(new TypeError('cannot read property of undefined'), host);

    expect(status()).toBe(500);
    expect(posthog.exceptions).toHaveLength(1);
    expect(posthog.exceptions[0]!.error).toBeInstanceOf(TypeError);
  });

  it('captures a thrown non-Error value', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);
    const { host, status } = makeHost();

    // `throw 'boom'` still produces a 500 for the caller, so it must still be
    // reported. The service is responsible for coercing it to an Error.
    filter.catch('boom', host);

    expect(status()).toBe(500);
    expect(posthog.exceptions).toHaveLength(1);
  });

  it('does not capture 4xx by default', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);

    for (const exception of [
      new UnauthorizedException('token expired'),
      new NotFoundException('no such agent'),
      new BadRequestException('invalid payload'),
    ]) {
      filter.catch(exception, makeHost().host);
    }

    expect(posthog.exceptions).toHaveLength(0);
  });

  it('captures 4xx when POSTHOG_CAPTURE_CLIENT_ERRORS is on', async () => {
    const HttpExceptionFilter = await loadFilter(true);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);
    const { host, status } = makeHost();

    filter.catch(new UnauthorizedException('token expired'), host);

    expect(status()).toBe(401);
    expect(posthog.exceptions).toHaveLength(1);
    expect(posthog.exceptions[0]!.properties?.status_code).toBe(401);
    expect(posthog.exceptions[0]!.properties?.error_code).toBe('UNAUTHORIZED');
  });

  it('still captures 5xx when the 4xx flag is on', async () => {
    const HttpExceptionFilter = await loadFilter(true);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);

    filter.catch(new Error('boom'), makeHost().host);

    expect(posthog.exceptions).toHaveLength(1);
  });

  it('captures a generic Prisma P2023 as a server fault', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);
    const { host, status, body } = makeHost();

    // P2023 means inconsistent column data and is not specific to malformed
    // request input. Route-boundary pipes handle known UUID parameters; an
    // unclassified P2023 must remain visible as a server fault.
    const prismaError = Object.assign(new Error('Inconsistent column data'), { code: 'P2023' });
    filter.catch(prismaError, host);

    expect(status()).toBe(500);
    expect(body()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(posthog.exceptions).toHaveLength(1);
    expect(posthog.exceptions[0]!.error).toBe(prismaError);
  });
});

describe('HttpExceptionFilter capture properties', () => {
  it('sends the route pattern and method, never the resolved URL', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);
    const { host } = makeHost({ route: '/agents/:id' });

    filter.catch(new Error('boom'), host);

    const properties = posthog.exceptions[0]!.properties!;
    expect(properties.route_path).toBe('/agents/:id');
    expect(properties.http_method).toBe('POST');
    // The resolved URL carries tenant and resource IDs and must not be sent.
    expect(JSON.stringify(properties)).not.toContain('44444444');
  });

  it('omits the route pattern when routing never resolved', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);
    const { host } = makeHost();

    filter.catch(new Error('boom'), host);

    expect(posthog.exceptions[0]!.properties).not.toHaveProperty('route_path');
  });
});

describe('HttpExceptionFilter error details', () => {
  it('withholds the error class in production but keeps the correlation id', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    vi.stubEnv('NODE_ENV', 'production');
    const filter = new HttpExceptionFilter(makePosthog() as never);
    const { host, body } = makeHost();

    // The masked message exists to keep internals off the wire; the error class
    // names the same internals (`PrismaClientKnownRequestError` and friends), so
    // it must not travel with the response.
    filter.catch(Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' }), host);

    const details = (body() as { error: { details?: Record<string, unknown> } }).error.details;
    expect(details).not.toHaveProperty('errorClass');
    expect(details).toMatchObject({ correlationId: CORRELATION_ID });
    expect(JSON.stringify(body())).not.toContain('Prisma');
  });

  it('includes the error class outside production for local debugging', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    vi.stubEnv('NODE_ENV', 'development');
    const filter = new HttpExceptionFilter(makePosthog() as never);
    const { host, body } = makeHost();

    filter.catch(new TypeError('boom'), host);

    expect((body() as { error: { details?: Record<string, unknown> } }).error.details).toMatchObject({
      errorClass: 'TypeError',
      correlationId: CORRELATION_ID,
    });
  });

  it('still reports the real exception to error tracking in production', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    vi.stubEnv('NODE_ENV', 'production');
    const posthog = makePosthog();
    const filter = new HttpExceptionFilter(posthog as never);

    // Withholding the class from the response must not cost the per-fault
    // fingerprint: error tracking receives the untouched exception.
    const err = Object.assign(new Error('boom'), { name: 'PrismaClientKnownRequestError' });
    filter.catch(err, makeHost().host);

    expect(posthog.exceptions[0]!.error).toBe(err);
  });
});

/**
 * `Retry-After` is the standard channel for a 429 wait time — proxies and SDK
 * backoff read the header, not `error.details`. Both rate-limit guards throw
 * the same `{ code: 'RATE_LIMITED', details: { retryAfterSeconds } }` shape, so
 * the filter is the single place the header is set.
 */
function rateLimited(details?: Record<string, unknown>): HttpException {
  return new HttpException(
    { code: 'RATE_LIMITED', message: 'Too many requests.', details },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

describe('HttpExceptionFilter Retry-After header', () => {
  it('sets Retry-After from details.retryAfterSeconds', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const filter = new HttpExceptionFilter(makePosthog() as never);
    const { host, status, headers } = makeHost();

    filter.catch(rateLimited({ retryAfterSeconds: 300 }), host);

    expect(status()).toBe(429);
    expect(headers['Retry-After']).toBe('300');
  });

  it('rounds a fractional wait up, never down', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const filter = new HttpExceptionFilter(makePosthog() as never);
    const { host, headers } = makeHost();

    filter.catch(rateLimited({ retryAfterSeconds: 1.2 }), host);

    expect(headers['Retry-After']).toBe('2');
  });

  it('caps an absurd wait so the header stays decimal digits, never exponential', async () => {
    // Number.MAX_VALUE passes the positive-finite check, and String() renders
    // anything >= 1e21 as exponential notation, which violates the RFC 9110
    // delay-seconds grammar (1*DIGIT).
    const HttpExceptionFilter = await loadFilter(false);
    const filter = new HttpExceptionFilter(makePosthog() as never);
    const { host, headers } = makeHost();

    filter.catch(rateLimited({ retryAfterSeconds: Number.MAX_VALUE }), host);

    expect(headers['Retry-After']).toBe('31536000');
    expect(headers['Retry-After']).toMatch(/^\d+$/);
  });

  it('emits no header when retryAfterSeconds is missing or not a positive number', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const filter = new HttpExceptionFilter(makePosthog() as never);

    for (const details of [
      undefined,
      { retryAfterSeconds: 0 },
      { retryAfterSeconds: -5 },
      { retryAfterSeconds: Number.NaN },
      { retryAfterSeconds: '60' },
    ]) {
      const { host, headers } = makeHost();
      filter.catch(rateLimited(details), host);
      expect(headers).not.toHaveProperty('Retry-After');
    }
  });

  it('emits no header for a non-rate-limit error', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const filter = new HttpExceptionFilter(makePosthog() as never);
    const { host, headers } = makeHost();

    filter.catch(new BadRequestException('invalid payload'), host);

    expect(headers).not.toHaveProperty('Retry-After');
  });

  it('still sets Retry-After in production', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    vi.stubEnv('NODE_ENV', 'production');
    const filter = new HttpExceptionFilter(makePosthog() as never);
    const { host, headers } = makeHost();

    filter.catch(rateLimited({ retryAfterSeconds: 60 }), host);

    expect(headers['Retry-After']).toBe('60');
  });
});

describe('HttpExceptionFilter without analytics', () => {
  it('still responds normally when no PostHog service is injected', async () => {
    const HttpExceptionFilter = await loadFilter(false);
    const filter = new HttpExceptionFilter();
    const { host, status, body } = makeHost();

    expect(() => filter.catch(new Error('boom'), host)).not.toThrow();
    expect(status()).toBe(500);
    expect(body()).toMatchObject({ success: false, data: null });
  });
});
