import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { CacheService } from '../cache/cache.service';
import { env } from '../config/env';

/**
 * Stricter per-user rate limit for LLM generation endpoints (chat-to-agent
 * messages and the sync spec builder). Sits on top of the global
 * RateLimitGuard: generation calls are orders of magnitude more expensive
 * than normal API requests, so they get their own budget.
 *
 * Defaults: 10 generations / 5 minutes per user (AGENT_GEN_RATE_LIMIT_MAX /
 * AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS).
 */
@Injectable()
export class GenerationRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(GenerationRateLimitGuard.name);
  private readonly max = env.AGENT_GEN_RATE_LIMIT_MAX;
  private readonly windowSec = env.AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS;

  constructor(private readonly cache: CacheService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user;
    // Without user context the auth guard rejects anyway.
    if (!user) return true;

    const workspaceId = req.params.workspaceId ?? user.active_workspace_id ?? 'global';
    const key = `vf:v1:ratelimit:gen:${workspaceId}:${user.id}`;
    const count = await this.cache.incr(key, this.windowSec);

    if (count > this.max) {
      this.logger.debug(`[gen-ratelimit] blocked user=${user.id} count=${count}`);
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Generation rate limit reached. Please wait a few minutes and try again.',
          retryAfterSeconds: this.windowSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
