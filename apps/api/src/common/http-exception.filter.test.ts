import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
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
}

function makeHost(options: { route?: string } = {}): HostResult {
  let sentStatus: number | undefined;
  let sentBody: unknown;

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
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;

  return { host, status: () => sentStatus, body: () => sentBody };
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
