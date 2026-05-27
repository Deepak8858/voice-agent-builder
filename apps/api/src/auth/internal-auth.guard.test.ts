import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { InternalAuthGuard } from './internal-auth.guard';
import { env } from '../config/env';

const APP_USER_ID = '11111111-1111-4111-8111-111111111111';

function makeContext(headers: Record<string, string>) {
  const req = { headers };
  return {
    req,
    ctx: {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext,
  };
}

describe('InternalAuthGuard Supabase trust boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(env, {
      INTERNAL_API_KEY: 'test-internal-api-key-with-32-chars',
    });
  });

  it('rejects forwarded user metadata when no Supabase bearer token is present', async () => {
    const reflector = { getAllAndOverride: vi.fn(() => false) };
    const authService = { getSessionUser: vi.fn() };
    const guard = new InternalAuthGuard(reflector as never, authService as never);
    const { ctx } = makeContext({
      'x-internal-key': 'test-internal-api-key-with-32-chars',
      'x-app-user-id': APP_USER_ID,
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow();
    expect(authService.getSessionUser).not.toHaveBeenCalled();
  });

  it('derives req.user from the verified Supabase token instead of spoofable headers', async () => {
    const reflector = { getAllAndOverride: vi.fn(() => false) };
    const authService = {
      getSessionUser: vi.fn(async () => ({
        id: APP_USER_ID,
        email: 'user@example.com',
        name: 'Verified User',
        active_workspace_id: '22222222-2222-4222-8222-222222222222',
        active_workspace_name: 'Verified Workspace',
        active_workspace_role: 'owner',
      })),
    };
    const guard = new InternalAuthGuard(reflector as never, authService as never);
    const { ctx, req } = makeContext({
      'x-internal-key': 'test-internal-api-key-with-32-chars',
      authorization: 'Bearer verified-token',
      'x-app-user-id': '33333333-3333-4333-8333-333333333333',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.getSessionUser).toHaveBeenCalledWith(req);
    expect(req).toMatchObject({
      user: expect.objectContaining({
        id: APP_USER_ID,
        email: 'user@example.com',
        active_workspace_role: 'owner',
      }),
    });
  });
});
