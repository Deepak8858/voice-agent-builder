import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import { CacheService } from '../cache/cache.service';
import { env } from '../config/env';
import type { SessionUser } from '@voiceforge/shared';

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

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly max: number;
  private readonly windowSec: number;

  constructor(private readonly cache: CacheService) {
    this.max = env.RATE_LIMIT_MAX ?? 100;
    this.windowSec = env.RATE_LIMIT_WINDOW_SECONDS ?? 60;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Allow routes marked with @SkipRateLimit()
    const skip = Reflect.getMetadata(SKIP_RATE_LIMIT_KEY, ctx.getHandler());
    if (skip) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user;

    // No user context means the auth guard will reject anyway; allow through
    // so auth errors are cleaner than a confusing rate-limit error.
    if (!user) return true;

    const key = `vf:v1:ratelimit:${user.active_workspace_id ?? 'global'}:${user.id}`;
    const count = await this.cache.incr(key, this.windowSec);

    if (count > this.max) {
      this.logger.debug(`[ratelimit] blocked user=${user.id} count=${count}`);
      throw new HttpException({
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: this.windowSec,
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    this.logger.debug(`[ratelimit] allowed user=${user.id} count=${count}/${this.max}`);
    return true;
  }
}
