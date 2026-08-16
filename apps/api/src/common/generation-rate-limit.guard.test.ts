import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';
import { GenerationRateLimitGuard } from './generation-rate-limit.guard';
import type { CacheService } from '../cache/cache.service';
import { env } from '../config/env';

function mockExecutionContext(user?: Partial<SessionUser>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T extends object>() => ({ user }) as T,
      getResponse: () => ({}),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('GenerationRateLimitGuard', () => {
  let guard: GenerationRateLimitGuard;
  let mockCache: { incr: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockCache = { incr: vi.fn().mockResolvedValue(1) };
    guard = new GenerationRateLimitGuard(mockCache as unknown as CacheService);
  });

  it('allows requests under the limit', async () => {
    mockCache.incr.mockResolvedValue(env.AGENT_GEN_RATE_LIMIT_MAX);
    const ctx = mockExecutionContext({ id: 'user_1', active_workspace_id: 'ws_1' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws 429 with retryAfterSeconds once the counter exceeds the max', async () => {
    mockCache.incr.mockResolvedValue(env.AGENT_GEN_RATE_LIMIT_MAX + 1);
    const ctx = mockExecutionContext({ id: 'user_1', active_workspace_id: 'ws_1' });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: env.AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS,
      },
    });
  });

  it('passes through when there is no user on the request', async () => {
    const ctx = mockExecutionContext(undefined);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockCache.incr).not.toHaveBeenCalled();
  });

  it('scopes the counter to the user and workspace with the window TTL', async () => {
    const ctx = mockExecutionContext({ id: 'user_abc', active_workspace_id: 'ws_xyz' });

    await guard.canActivate(ctx);

    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:gen:ws_xyz:user_abc',
      env.AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS,
    );
  });

  it('falls back to a global scope when the user has no active workspace', async () => {
    const ctx = mockExecutionContext({ id: 'user_abc' });

    await guard.canActivate(ctx);

    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:gen:global:user_abc',
      expect.any(Number),
    );
  });
});
