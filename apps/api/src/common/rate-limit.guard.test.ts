import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { Controller, Get, type ArgumentsHost, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard, SKIP_RATE_LIMIT_KEY, SkipRateLimit } from './rate-limit.guard';
import { HttpExceptionFilter } from './http-exception.filter';
import { MetricsController } from './metrics.controller';
import { InternalOnly } from './decorators/internal-only.decorator';
import { Public } from './decorators/public.decorator';
import { CacheService } from '../cache/cache.service';
import { env } from '../config/env';
import type { SessionUser } from '@voiceforge/shared';

/**
 * A real Reflector over real decorated classes, because the exemptions are the
 * whole point: a stubbed reflector would pass whether the guard reads
 * ctx.getClass() or not, and reading only the handler is what left every
 * class-level @Public() webhook unexempt.
 */
@Public()
@Controller('local-class-public')
class ClassPublicController {
  @Get()
  handler() { return 'ok'; }
}

@Controller('local-method-public')
class MethodPublicController {
  @Get()
  @Public()
  publicHandler() { return 'ok'; }

  @Get('other')
  guardedHandler() { return 'ok'; }
}

@Controller('local-skip')
class SkipController {
  @Get()
  @SkipRateLimit()
  handler() { return 'ok'; }
}

/**
 * The shape of every real runtime route: @InternalOnly() at class level, no
 * @SkipRateLimit(). These arrive with no req.user by design, so without the
 * exemption they would all share one per-IP bucket.
 */
@InternalOnly()
@Controller('local-internal')
class InternalOnlyController {
  @Get()
  handler() { return 'ok'; }
}

/**
 * Every exemption case passes a user, so `incr` would be called — and the
 * assertion fail — if the exemption regressed. Keyed off the no-user branch
 * instead, these tests would pass whether the exemption fired or not.
 */
const EXEMPT_REQ = { user: { id: 'user_1', active_workspace_id: 'ws_1' }, ip: '203.0.113.7' };

function ctxFor(
  target: { cls: new (...args: never[]) => object; handler: (...args: never[]) => unknown },
  req: { user?: Partial<SessionUser>; ip?: string } = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T extends object>() => req as T,
      getResponse: () => ({}),
    }),
    getHandler: () => target.handler,
    getClass: () => target.cls,
  } as unknown as ExecutionContext;
}

const GUARDED = {
  cls: MethodPublicController,
  handler: MethodPublicController.prototype.guardedHandler,
};

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let mockCache: { incr: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockCache = { incr: vi.fn().mockResolvedValue(1) };
    guard = new RateLimitGuard(mockCache as unknown as CacheService, new Reflector());
  });

  it('allows request when under rate limit', async () => {
    const ctx = ctxFor(GUARDED, { user: { id: 'user_1' } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('blocks request when rate limit exceeded', async () => {
    mockCache.incr.mockResolvedValue(101); // above default limit
    const ctx = ctxFor(GUARDED, { user: { id: 'user_1' } });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
  });

  it('keys an authenticated request by workspace and user', async () => {
    const ctx = ctxFor(GUARDED, { user: { id: 'user_abc', active_workspace_id: 'ws_xyz' } });
    await guard.canActivate(ctx);
    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:ws_xyz:user_abc',
      expect.any(Number),
    );
  });

  it('keys an unauthenticated request by client IP', async () => {
    const ctx = ctxFor(GUARDED, { ip: '203.0.113.7' });
    await guard.canActivate(ctx);
    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:ip:203.0.113.7',
      expect.any(Number),
    );
  });

  it('rejects an unauthenticated burst past the limit', async () => {
    // The counter is Redis-side; simulate the burst by returning what incr
    // would return on the 101st request in the window.
    mockCache.incr.mockResolvedValue(101);
    const ctx = ctxFor(GUARDED, { ip: '203.0.113.7' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: 429,
      response: { code: 'RATE_LIMITED' },
    });
  });

  it('never limits a controller whose @Public() is declared at class level', async () => {
    // MetricsController is one of the five real class-level @Public()
    // controllers (with the Stripe, Twilio, Vobiz and health ones).
    const ctx = ctxFor(
      { cls: MetricsController, handler: MetricsController.prototype.getMetrics },
      EXEMPT_REQ,
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockCache.incr).not.toHaveBeenCalled();
  });

  it('never limits a locally declared class-level @Public() controller', async () => {
    const ctx = ctxFor(
      { cls: ClassPublicController, handler: ClassPublicController.prototype.handler },
      EXEMPT_REQ,
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockCache.incr).not.toHaveBeenCalled();
  });

  it('never limits a method-level @Public() handler', async () => {
    const ctx = ctxFor(
      { cls: MethodPublicController, handler: MethodPublicController.prototype.publicHandler },
      EXEMPT_REQ,
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockCache.incr).not.toHaveBeenCalled();
  });

  it('never limits a @SkipRateLimit() handler', async () => {
    const ctx = ctxFor(
      { cls: SkipController, handler: SkipController.prototype.handler },
      EXEMPT_REQ,
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockCache.incr).not.toHaveBeenCalled();
  });

  it('never limits an @InternalOnly() controller, even with no user', async () => {
    // This is the case that hangs up live calls if it regresses: the metering,
    // tool and knowledge routes our runtime calls are @InternalOnly() and carry
    // no user, so one shared per-IP bucket 429s them once concurrent calls
    // exceed RATE_LIMIT_MAX, and CallMeter answers a sustained 429 by
    // terminating the call.
    const ctx = ctxFor(
      { cls: InternalOnlyController, handler: InternalOnlyController.prototype.handler },
      { ip: '10.0.1.5' },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockCache.incr).not.toHaveBeenCalled();
  });
});

/**
 * Asserted through the REAL exception filter, and in production mode, because
 * that is the only place either half of the 429 envelope is observable. The
 * filter rebuilds the response from `code`/`message`/`details` alone, so a
 * `retryAfterSeconds` thrown at the top level is silently dropped; and it keeps
 * `details` in production only when the code is exactly `RATE_LIMITED`, so the
 * old `RATE_LIMIT_EXCEEDED` spelling stripped the hint even once it was nested.
 * Both defects are invisible to an assertion on the thrown exception.
 */
describe('the 429 a client actually receives', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('carries code RATE_LIMITED and retryAfterSeconds in details, in production', async () => {
    // isProduction() reads process.env on every call, so no re-import is needed.
    vi.stubEnv('NODE_ENV', 'production');

    const cache = { incr: vi.fn().mockResolvedValue(env.RATE_LIMIT_MAX + 1) };
    const guard = new RateLimitGuard(cache as unknown as CacheService, new Reflector());

    let thrown: unknown;
    try {
      await guard.canActivate(ctxFor(GUARDED, { user: { id: 'user_1' } }));
    } catch (error) {
      thrown = error;
    }

    let sentStatus: number | undefined;
    let sentBody: unknown;
    const headers: Record<string, string> = {};
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
        getRequest: () => ({ method: 'GET', url: '/api/v1/agents' }),
        getResponse: () => res,
      }),
    } as unknown as ArgumentsHost;

    new HttpExceptionFilter().catch(thrown, host);

    expect(sentStatus).toBe(429);
    expect(sentBody).toEqual({
      success: false,
      data: null,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please wait before trying again.',
        details: { retryAfterSeconds: env.RATE_LIMIT_WINDOW_SECONDS },
      },
    });
    // The JSON hint is the convenience copy; `Retry-After` is the channel
    // proxies and SDK backoff actually read.
    expect(headers['Retry-After']).toBe(String(env.RATE_LIMIT_WINDOW_SECONDS));
  });
});

/**
 * The guard exemption above is only worth anything if the runtime's hot paths
 * actually carry the decorator and do not carry @SkipRateLimit() instead.
 */
describe('runtime routes rely on the @InternalOnly() exemption', () => {
  for (const file of [
    '../billing/runtime-usage.controller.ts',
    '../tools/livekit-tools.controller.ts',
    '../voice/livekit-knowledge.controller.ts',
  ]) {
    it(`${file} is @InternalOnly() and not @SkipRateLimit()`, () => {
      const source = readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source).toContain('@InternalOnly()');
      expect(source).not.toContain('@SkipRateLimit()');
    });
  }
});

describe('SKIP_RATE_LIMIT_KEY', () => {
  it('is exported as a symbol', () => {
    expect(typeof SKIP_RATE_LIMIT_KEY).toBe('symbol');
  });
});

/**
 * Source-level pins. AppModule cannot be imported here — it starts
 * OpenTelemetry and the whole module graph — and both facts are one-line
 * textual properties of the file, so read the file.
 */
describe('app.module.ts global guard wiring', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../app.module.ts'),
    'utf8',
  );

  it('does not register RateLimitGuard a second time', () => {
    // Two APP_GUARD registrations means two instances run and every request is
    // counted twice, so the effective limit is half of RATE_LIMIT_MAX.
    expect(source).not.toContain('provide: APP_GUARD');
    expect(source).not.toContain('useClass: RateLimitGuard');
  });

  it('imports RateLimitModule after AuthModule', () => {
    // Nest resolves global guards in imports-array order, so this is what puts
    // RateLimitGuard after InternalAuthGuard and therefore gives it req.user.
    expect(source.indexOf('\n    RateLimitModule,')).toBeGreaterThan(
      source.indexOf('\n    AuthModule,'),
    );
    expect(source).toContain('\n    AuthModule,');
  });
});
