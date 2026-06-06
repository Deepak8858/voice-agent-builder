import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceGuard } from './workspace.guard';
import { env } from '../config/env';

function contextFor(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
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
});
