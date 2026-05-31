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

    const guard = new WorkspaceGuard(prisma as never, auth as never);

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
    expect(auth.getSessionUser).toHaveBeenCalledWith(req);
    expect(req).toMatchObject({
      user: {
        id: 'user-1',
        active_workspace_id: 'workspace-1',
        active_workspace_role: 'owner',
      },
    });
  });
});
