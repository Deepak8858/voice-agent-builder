import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CacheService } from '../cache/cache.service';
import { env } from '../config/env';
import type { SessionUser } from '@voiceforge/shared';
import { IS_INTERNAL_ONLY_KEY } from './decorators/internal-only.decorator';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Metadata key used by @SkipRateLimit() to mark routes to skip rate limiting.
 */
export const SKIP_RATE_LIMIT_KEY = Symbol('SKIP_RATE_LIMIT');

/**
 * Decorator to skip rate limiting on a specific route handler.
 * Apply to controller methods that should be exempt from rate limiting.
 *
 * @example
 * ```ts
 * @Get('health')
 * @SkipRateLimit()
 * getHealth() { ... }
 * ```
 */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);

/**
 * Global request limiter. Bound once, by RateLimitModule, which app.module.ts
 * imports AFTER AuthModule so this runs after InternalAuthGuard has set
 * req.user — Nest resolves global guards in imports-array order, root module
 * first. Ordering is load-bearing: bound earlier, req.user is always undefined
 * and every request would fall to the per-IP key, which for the dashboard
 * means ONE bucket for all tenants (the web proxy at
 * apps/web/app/api/proxy/[...path]/route.ts calls the API server-side and
 * forwards no X-Forwarded-For, so the API sees a single source address).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly max: number;
  private readonly windowSec: number;

  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {
    this.max = env.RATE_LIMIT_MAX ?? 100;
    this.windowSec = env.RATE_LIMIT_WINDOW_SECONDS ?? 60;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Both exemptions must read the controller class as well as the handler:
    // every provider-webhook and liveness controller declares @Public() at
    // CLASS level, so the old handler-only Reflect.getMetadata() read never
    // saw it. Reading only the handler here would rate-limit Stripe, Twilio
    // and Vobiz callbacks — which all arrive from a handful of provider IPs —
    // plus the deploy health probe.
    if (this.metadata(SKIP_RATE_LIMIT_KEY, ctx)) return true;
    if (this.metadata(IS_PUBLIC_KEY, ctx)) return true;

    // @InternalOnly() routes are our own voice runtime, not a tenant. They
    // reach here with no req.user by design (InternalAuthGuard accepts the bare
    // internal key only on these routes and sets no user), so they would all
    // share the per-IP bucket below — one bucket for the whole livekit-agent
    // container. Metering emits a minute_tick per active call per minute, and
    // tool/knowledge lookups fire per conversation turn, so ~100 concurrent
    // calls exhaust RATE_LIMIT_MAX and the 429s make CallMeter terminate live
    // calls with `metering_unavailable`. Exempting them here rather than
    // returning early on `!user` keeps the per-IP branch fail-safe: if this
    // guard is ever bound before AuthModule again, unauthenticated traffic is
    // limited instead of silently unlimited.
    if (this.metadata(IS_INTERNAL_ONLY_KEY, ctx)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user;

    // req.ip, not a hand-rolled X-Forwarded-For parse: main.ts sets
    // `trust proxy` to env.TRUST_PROXY_HOPS, so Express already resolves the
    // client address for the deployed nginx hop count.
    const subject = user
      ? `${user.active_workspace_id ?? 'global'}:${user.id}`
      : `ip:${req.ip ?? 'unknown'}`;

    // cache.incr fails OPEN — it returns 1 when Redis is unreachable or the
    // pipeline errors. Six other callers depend on that, so it stays. The
    // consequence here is that the limit only holds while Redis is up;
    // accepted, because locking out all traffic on a cache blip is worse than
    // briefly not limiting it.
    const count = await this.cache.incr(`vf:v1:ratelimit:${subject}`, this.windowSec);

    if (count > this.max) {
      this.logger.debug(`[ratelimit] blocked subject=${subject} count=${count}`);
      throw new HttpException({
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: this.windowSec,
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    this.logger.debug(`[ratelimit] allowed subject=${subject} count=${count}/${this.max}`);
    return true;
  }

  private metadata(key: symbol | string, ctx: ExecutionContext): boolean {
    return this.reflector.getAllAndOverride<boolean>(key, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) === true;
  }
}
