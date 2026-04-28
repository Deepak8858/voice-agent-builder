import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { RateLimitGuard, SKIP_RATE_LIMIT_KEY } from './rate-limit.guard';
import { CacheService } from '../cache/cache.service';
import type { SessionUser } from '@voiceforge/shared';

function mockExecutionContext(user?: Partial<SessionUser>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T extends object>() => ({ user }) as T,
      getResponse: () => ({}),
    }),
    getHandler: () => ({
      getMetadata: vi.fn().mockReturnValue(undefined),
    }),
    getClass: () => ({}),
  } as ExecutionContext;
}

describe('RateLimitGuard', () => {
  let guard: CanActivate;
  let mockCache: { incr: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockCache = {
      incr: vi.fn().mockResolvedValue(1),
    };
    guard = new RateLimitGuard(mockCache as CacheService);
  });

  it('allows request when under rate limit', async () => {
    mockCache.incr.mockResolvedValue(1);
    const ctx = mockExecutionContext({ id: 'user_1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('blocks request when rate limit exceeded', async () => {
    mockCache.incr.mockResolvedValue(101); // above default limit
    const ctx = mockExecutionContext({ id: 'user_1' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('uses per-user rate limit key', async () => {
    mockCache.incr.mockResolvedValue(1);
    const user = { id: 'user_abc', active_workspace_id: 'ws_xyz' };
    const ctx = mockExecutionContext(user);
    await guard.canActivate(ctx);
    expect(mockCache.incr).toHaveBeenCalledWith(
      expect.stringContaining('user_abc'),
      expect.any(Number),
    );
  });

  it('uses per-workspace rate limit key', async () => {
    mockCache.incr.mockResolvedValue(1);
    const user = { id: 'user_abc', active_workspace_id: 'ws_xyz' };
    const ctx = mockExecutionContext(user);
    await guard.canActivate(ctx);
    expect(mockCache.incr).toHaveBeenCalledWith(
      expect.stringContaining('ws_xyz'),
      expect.any(Number),
    );
  });
});

describe('SKIP_RATE_LIMIT_KEY', () => {
  it('is exported as a symbol', () => {
    expect(typeof SKIP_RATE_LIMIT_KEY).toBe('symbol');
  });
});
