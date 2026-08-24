import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceGuard } from './workspace.guard';
import { ForbiddenError } from './errors';
import { IS_SESSION_SCOPED_KEY } from './decorators/session-scoped.decorator';
import { env } from '../config/env';

function contextFor(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  };
}

/** Stands in for Nest's Reflector, returning a fixed @SessionScoped() answer. */
function reflectorStub(sessionScoped: boolean) {
  return {
    getAllAndOverride: vi.fn((key: string) =>
      key === IS_SESSION_SCOPED_KEY ? sessionScoped : undefined,
    ),
  };
}

describe('WorkspaceGuard', () => {
  beforeEach(() => {
    Object.assign(env, { INTERNAL_API_KEY: 'x'.repeat(32) });
  });

  it('builds req.user from a valid bearer token when global auth has not populated it yet', async () => {
    const prisma = {
      workspace: {
        findUnique: vi.fn(async () => ({ id: 'workspace-1', name: 'Demo Workspace' })),
      },
      membership: {
        findUnique: vi.fn(async () => ({ role: 'owner' })),
      },
    };
    const auth = {
      getSessionUser: vi.fn(async () => ({
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        active_workspace_id: 'workspace-1',
        active_workspace_name: 'Demo Workspace',
        active_workspace_role: 'owner',
      })),
    };
    const req = {
      params: { workspaceId: 'workspace-1' },
      headers: {
        authorization: 'Bearer token',
        'x-internal-key': env.INTERNAL_API_KEY,
      },
    };

    const cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };
    const guard = new WorkspaceGuard(prisma as never, auth as never, cache as never);

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
    expect(auth.getSessionUser).toHaveBeenCalledWith(req);
    expect(cache.set).toHaveBeenCalledWith(
      'workspace:access:workspace-1:user-1',
      {
        id: 'workspace-1',
        name: 'Demo Workspace',
        role: 'owner',
      },
      300,
    );
    expect(req).toMatchObject({
      user: {
        id: 'user-1',
        active_workspace_id: 'workspace-1',
        active_workspace_role: 'owner',
      },
    });
  });

  it('uses cached workspace membership on repeated dashboard API calls', async () => {
    const prisma = {
      workspace: {
        findUnique: vi.fn(async () => {
          throw new Error('workspace lookup should be cached');
        }),
      },
      membership: {
        findUnique: vi.fn(async () => {
          throw new Error('membership lookup should be cached');
        }),
      },
    };
    const auth = {
      getSessionUser: vi.fn(),
    };
    const cache = {
      get: vi.fn(async () => ({
        id: 'workspace-1',
        name: 'Demo Workspace',
        role: 'admin',
      })),
      set: vi.fn(async () => undefined),
    };
    const req = {
      params: { workspaceId: 'workspace-1' },
      headers: {},
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        active_workspace_id: 'workspace-1',
        active_workspace_name: 'Demo Workspace',
        active_workspace_role: 'owner',
      },
    };

    const guard = new WorkspaceGuard(prisma as never, auth as never, cache as never);

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
    expect(cache.get).toHaveBeenCalledWith('workspace:access:workspace-1:user-1');
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({
      active_workspace_id: 'workspace-1',
      active_workspace_name: 'Demo Workspace',
      active_workspace_role: 'admin',
    });
  });

  it('refuses a workspace the caller has no membership in', async () => {
    const prisma = {
      workspace: {
        findUnique: vi.fn(async () => ({ id: 'victim-workspace', name: 'Victim' })),
      },
      membership: {
        findUnique: vi.fn(async () => null),
      },
    };
    const cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };
    const req = {
      params: { workspaceId: 'victim-workspace' },
      headers: {},
      user: {
        id: 'attacker-1',
        email: 'attacker@example.com',
        name: null,
        active_workspace_id: 'attacker-workspace',
        active_workspace_name: 'Attacker',
        active_workspace_role: 'owner',
      },
    };

    const guard = new WorkspaceGuard(
      prisma as never,
      { getSessionUser: vi.fn() } as never,
      cache as never,
    );

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // A refused caller must not leave a grant behind for the next request.
    expect(cache.set).not.toHaveBeenCalled();
  });

  // Regression test for the silent no-op. This guard used to `return true` for
  // any route without a :workspaceId param, so applying it to a route keyed by
  // :orgId (e.g. the contact erasure endpoint) authorized nothing while looking
  // guarded. Reverting the fail-closed branch makes this test pass `true`.
  it('refuses a route with no :workspaceId param instead of silently allowing it', async () => {
    const prisma = {
      workspace: { findUnique: vi.fn() },
      membership: { findUnique: vi.fn() },
    };
    const req = {
      params: { orgId: 'someone-elses-org', contactId: 'contact-1' },
      headers: {},
      user: {
        id: 'attacker-1',
        email: 'attacker@example.com',
        name: null,
        active_workspace_id: 'attacker-workspace',
        active_workspace_name: 'Attacker',
        active_workspace_role: 'owner',
      },
    };

    const guard = new WorkspaceGuard(
      prisma as never,
      { getSessionUser: vi.fn() } as never,
      { get: vi.fn(), set: vi.fn() } as never,
      reflectorStub(false) as never,
    );

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('allows a param-less route that explicitly opts in with @SessionScoped()', async () => {
    const req = {
      params: {},
      headers: {},
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        active_workspace_id: 'workspace-1',
        active_workspace_name: 'Demo Workspace',
        active_workspace_role: 'owner',
      },
    };

    const guard = new WorkspaceGuard(
      { workspace: { findUnique: vi.fn() }, membership: { findUnique: vi.fn() } } as never,
      { getSessionUser: vi.fn() } as never,
      { get: vi.fn(), set: vi.fn() } as never,
      reflectorStub(true) as never,
    );

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
  });
});
