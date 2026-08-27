import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { InternalAuthGuard } from './internal-auth.guard';
import { IS_INTERNAL_ONLY_KEY } from '../common/decorators/internal-only.decorator';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { env } from '../config/env';

const APP_USER_ID = '11111111-1111-4111-8111-111111111111';

function makeContext(headers: Record<string, string>) {
  const req = { headers, method: 'POST', path: '/internal/runtime/usage/events' };
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

/**
 * Reflector stand-in keyed by metadata key, so a test can mark a route
 * internal-only without also marking it public.
 */
function makeReflector(metadata: Record<string, boolean> = {}) {
  return {
    getAllAndOverride: vi.fn((key: string) => metadata[key] ?? false),
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
    const reflector = makeReflector();
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
    const reflector = makeReflector();
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

/**
 * The internal key is not a secret the browser cannot obtain the use of: the
 * Next.js proxy holds it and forwards any path a signed-in user requests. So
 * possession of the key must not be sufficient to reach a route that only our
 * own runtime may call, or a user can forge metering events for their own
 * calls and refund themselves mid-call.
 */
describe('InternalAuthGuard internal-only routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(env, {
      INTERNAL_API_KEY: 'test-internal-api-key-with-32-chars',
    });
  });

  it('refuses an internal-only route when the request carries a user session', async () => {
    const reflector = makeReflector({ [IS_INTERNAL_ONLY_KEY]: true });
    const authService = { getSessionUser: vi.fn() };
    const guard = new InternalAuthGuard(reflector as never, authService as never);
    // Exactly what the web proxy sends: the server-side internal key plus the
    // caller's Supabase bearer token.
    const { ctx } = makeContext({
      'x-internal-key': 'test-internal-api-key-with-32-chars',
      authorization: 'Bearer verified-token',
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow();
    // Refused on the user context alone; the token is never even resolved.
    expect(authService.getSessionUser).not.toHaveBeenCalled();
  });

  it('admits the runtime on an internal-only route, which sends no user context', async () => {
    const reflector = makeReflector({ [IS_INTERNAL_ONLY_KEY]: true });
    const authService = { getSessionUser: vi.fn() };
    const guard = new InternalAuthGuard(reflector as never, authService as never);
    const { ctx, req } = makeContext({
      'x-internal-key': 'test-internal-api-key-with-32-chars',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req).not.toHaveProperty('user');
  });

  it('still admits a user session on a route that is not internal-only', async () => {
    const reflector = makeReflector({ [IS_INTERNAL_ONLY_KEY]: false });
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
    const { ctx } = makeContext({
      'x-internal-key': 'test-internal-api-key-with-32-chars',
      authorization: 'Bearer verified-token',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.getSessionUser).toHaveBeenCalled();
  });

  it('leaves public routes open without consulting the internal-only flag', async () => {
    const reflector = makeReflector({
      [IS_PUBLIC_KEY]: true,
      [IS_INTERNAL_ONLY_KEY]: true,
    });
    const authService = { getSessionUser: vi.fn() };
    const guard = new InternalAuthGuard(reflector as never, authService as never);
    const { ctx } = makeContext({});

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
