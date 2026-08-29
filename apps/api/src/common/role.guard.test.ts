import { describe, expect, it, vi } from 'vitest';
import { RoleGuard } from './role.guard';
import { ForbiddenError, UnauthorizedError } from './errors';
import { REQUIRED_ROLE_KEY, RequiredRoleMetadata } from './decorators/required-role.decorator';

function contextFor(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  };
}

/** Stands in for Nest's Reflector, returning fixed @RequiredRole() metadata. */
function reflectorStub(meta: RequiredRoleMetadata | undefined) {
  return {
    getAllAndOverride: vi.fn((key: string) => (key === REQUIRED_ROLE_KEY ? meta : undefined)),
  };
}

function guardWith({
  meta,
  dbRole = null,
  cachedRole = null,
}: {
  meta: RequiredRoleMetadata | undefined;
  dbRole?: string | null;
  cachedRole?: string | null;
}) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (dbRole ? { role: dbRole } : null)),
    },
  };
  const cache = {
    get: vi.fn(async () =>
      cachedRole ? { id: 'ws-1', name: 'Workspace', role: cachedRole } : null,
    ),
    set: vi.fn(async () => undefined),
  };
  const guard = new RoleGuard(prisma as never, cache as never, reflectorStub(meta) as never);
  return { guard, prisma, cache };
}

const memberReq = (role: string) => ({
  params: { workspaceId: 'ws-1' },
  user: {
    id: 'user-1',
    email: 'user@example.com',
    name: null,
    active_workspace_id: 'ws-1',
    active_workspace_name: 'Workspace',
    active_workspace_role: role,
  },
});

describe('RoleGuard', () => {
  it('allows a member whose resolved role is on the allow-list', async () => {
    const { guard } = guardWith({ meta: { roles: ['owner', 'admin'], fresh: false }, dbRole: 'admin' });

    await expect(guard.canActivate(contextFor(memberReq('admin')) as never)).resolves.toBe(true);
  });

  it('refuses a member whose resolved role is off the allow-list', async () => {
    const { guard } = guardWith({ meta: { roles: ['owner', 'admin'], fresh: false }, dbRole: 'editor' });

    await expect(guard.canActivate(contextFor(memberReq('editor')) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses a caller with no membership row at all', async () => {
    const { guard } = guardWith({ meta: { roles: ['owner', 'admin'], fresh: false }, dbRole: null });

    await expect(guard.canActivate(contextFor(memberReq('owner')) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  // THE TRAP this guard exists to close. On a @SessionScoped() route there is
  // no :workspaceId param, so WorkspaceGuard never refined the role and
  // req.user.active_workspace_role is whatever buildSessionUser cached — the
  // caller's oldest membership, not their seat in the workspace this request
  // targets. Here that stale field says 'owner' while the actual membership in
  // active_workspace_id is 'viewer': trusting the field would escalate.
  it('re-resolves the role on a session-scoped route instead of trusting the session field', async () => {
    const { guard, prisma } = guardWith({
      meta: { roles: ['owner', 'admin'], fresh: false },
      dbRole: 'viewer',
    });
    const req = {
      params: {},
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        active_workspace_id: 'ws-active',
        active_workspace_name: 'Active Workspace',
        active_workspace_role: 'owner', // stale: oldest-membership role
      },
    };

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: 'user-1', workspaceId: 'ws-active' } },
      select: { role: true },
    });
  });

  it('reuses the workspace-access cache WorkspaceGuard populated', async () => {
    const { guard, prisma, cache } = guardWith({
      meta: { roles: ['owner', 'admin'], fresh: false },
      cachedRole: 'admin',
      dbRole: null,
    });

    await expect(guard.canActivate(contextFor(memberReq('admin')) as never)).resolves.toBe(true);
    expect(cache.get).toHaveBeenCalledWith('workspace:access:ws-1:user-1');
    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
  });

  // A demotion must bite immediately on fresh routes: the cache still says
  // 'owner' for up to 300s, the row says 'viewer', and {fresh:true} must
  // believe the row without even reading the cache.
  it('skips the cache entirely when the decorator asks for a fresh read', async () => {
    const { guard, cache } = guardWith({
      meta: { roles: ['owner', 'admin'], fresh: true },
      cachedRole: 'owner',
      dbRole: 'viewer',
    });

    await expect(guard.canActivate(contextFor(memberReq('owner')) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('refuses a request the auth guards never populated', async () => {
    const { guard } = guardWith({ meta: { roles: ['owner'], fresh: false }, dbRole: 'owner' });

    await expect(
      guard.canActivate(contextFor({ params: { workspaceId: 'ws-1' } }) as never),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  // The retrofit pass across the remaining controllers is the likely way this
  // guard gets bound to a route keyed by something other than :workspaceId.
  // There the active_workspace_id fallback would check the caller's role in
  // their own session workspace while the handler acts on the org in the path,
  // so it must refuse rather than pass.
  it.each(['organizationId', 'orgId', 'clientId'])(
    'refuses a route keyed by :%s instead of checking the session workspace',
    async (param) => {
      const { guard, prisma } = guardWith({
        meta: { roles: ['owner', 'admin'], fresh: false },
        dbRole: 'owner',
      });
      const req = { params: { [param]: 'other-tenant' }, user: memberReq('owner').user };

      await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    },
  );

  it('still authorizes a :workspaceId route that also carries an org param', async () => {
    const { guard } = guardWith({ meta: { roles: ['owner'], fresh: false }, dbRole: 'owner' });
    const req = {
      params: { workspaceId: 'ws-1', organizationId: 'org-1' },
      user: memberReq('owner').user,
    };

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
  });

  // Binding RoleGuard without @RequiredRole() must not become a silent no-op —
  // that is the same failure mode WorkspaceGuard had for missing params.
  it('fails closed when bound to a route with no @RequiredRole() metadata', async () => {
    const { guard } = guardWith({ meta: undefined, dbRole: 'owner' });

    await expect(guard.canActivate(contextFor(memberReq('owner')) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
