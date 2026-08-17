import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';
import { GenerationRateLimitGuard } from './generation-rate-limit.guard';
import type { CacheService } from '../cache/cache.service';
import { env } from '../config/env';

function mockExecutionContext(
  user?: Partial<SessionUser>,
  params: Record<string, string> = {},
  routePath?: string,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T extends object>() =>
        ({ user, params, ...(routePath ? { route: { path: routePath } } : {}) }) as T,
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

  it('throws 429 with retryAfterSeconds in details once the counter exceeds the max', async () => {
    mockCache.incr.mockResolvedValue(env.AGENT_GEN_RATE_LIMIT_MAX + 1);
    const ctx = mockExecutionContext({ id: 'user_1', active_workspace_id: 'ws_1' });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: env.AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS },
      },
    });
  });

  it('passes through when there is no user on the request', async () => {
    const ctx = mockExecutionContext(undefined);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockCache.incr).not.toHaveBeenCalled();
  });

  it('scopes the counter to the route workspace param over the active workspace', async () => {
    const ctx = mockExecutionContext(
      { id: 'user_abc', active_workspace_id: 'ws_other' },
      { workspaceId: 'ws_xyz' },
    );

    await guard.canActivate(ctx);

    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:gen:ws_xyz:user_abc',
      env.AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS,
    );
  });

  it('falls back to the active workspace for unscoped generation routes', async () => {
    const ctx = mockExecutionContext({ id: 'user_abc', active_workspace_id: 'ws_active' });

    await guard.canActivate(ctx);

    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:gen:ws_active:user_abc',
      expect.any(Number),
    );
  });

  it('uses a separate counter for finalization', async () => {
    const ctx = mockExecutionContext(
      { id: 'user_abc', active_workspace_id: 'ws_other' },
      { workspaceId: 'ws_xyz' },
      ':sessionId/finalize',
    );

    await guard.canActivate(ctx);

    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:finalize:ws_xyz:user_abc',
      env.AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS,
    );
  });

  it('falls back to a global scope when neither param nor active workspace exists', async () => {
    const ctx = mockExecutionContext({ id: 'user_abc' });

    await guard.canActivate(ctx);

    expect(mockCache.incr).toHaveBeenCalledWith(
      'vf:v1:ratelimit:gen:global:user_abc',
      expect.any(Number),
    );
  });
});
