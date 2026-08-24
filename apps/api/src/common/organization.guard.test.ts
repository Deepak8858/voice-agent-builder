import { describe, expect, it, vi } from 'vitest';
import { OrganizationGuard } from './organization.guard';
import { ForbiddenError, UnauthorizedError } from './errors';

function contextFor(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  };
}

function cacheStub(hit: unknown = null) {
  return {
    get: vi.fn(async () => hit),
    set: vi.fn(async () => undefined),
  };
}

function prismaStub(opts: { membership?: unknown; organization?: unknown } = {}) {
  return {
    membership: { findFirst: vi.fn(async () => opts.membership ?? null) },
    organization: { findFirst: vi.fn(async () => opts.organization ?? null) },
  };
}

const MEMBER = {
  id: 'user-1',
  email: 'member@example.com',
  name: null,
  active_workspace_id: 'workspace-1',
  active_workspace_name: 'Own Workspace',
  active_workspace_role: 'owner' as const,
};

describe('OrganizationGuard', () => {
  it('admits a caller who is a member of a workspace inside the org', async () => {
    const prisma = prismaStub({ membership: { id: 'membership-1' } });
    const cache = cacheStub();
    const req = { params: { orgId: 'org-1' }, headers: {}, user: MEMBER };

    const guard = new OrganizationGuard(prisma as never, cache as never);

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', workspace: { organizationId: 'org-1' } },
      select: { id: true },
    });
    expect(cache.set).toHaveBeenCalledWith('org:access:org-1:user-1', true, 300);
  });

  it('admits the organization owner even without a workspace membership', async () => {
    const prisma = prismaStub({ membership: null, organization: { id: 'org-1' } });
    const req = { params: { orgId: 'org-1' }, headers: {}, user: MEMBER };

    const guard = new OrganizationGuard(prisma as never, cacheStub() as never);

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
    expect(prisma.organization.findFirst).toHaveBeenCalledWith({
      where: { id: 'org-1', ownerUserId: 'user-1' },
      select: { id: true },
    });
  });

  // This is the defect the guard exists to close: /v1/orgs/:orgId/audit-logs
  // had no guard, so orgId was attacker-chosen and flowed into
  // where.organizationId.
  it('refuses a caller who belongs to neither a workspace in the org nor owns it', async () => {
    const prisma = prismaStub({ membership: null, organization: null });
    const cache = cacheStub();
    const req = { params: { orgId: 'someone-elses-org' }, headers: {}, user: MEMBER };

    const guard = new OrganizationGuard(prisma as never, cache as never);

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before touching the database', async () => {
    const prisma = prismaStub();
    const req = { params: { orgId: 'org-1' }, headers: {} };

    const guard = new OrganizationGuard(prisma as never, cacheStub() as never);

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
  });

  // Fails closed rather than repeating WorkspaceGuard's original mistake of
  // returning true when the expected param is absent.
  it('refuses when applied to a route with no :orgId param', async () => {
    const prisma = prismaStub({ membership: { id: 'membership-1' } });
    const req = { params: {}, headers: {}, user: MEMBER };

    const guard = new OrganizationGuard(prisma as never, cacheStub() as never);

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
  });

  it('serves a cached grant without re-querying membership', async () => {
    const prisma = prismaStub();
    const cache = cacheStub(true);
    const req = { params: { orgId: 'org-1' }, headers: {}, user: MEMBER };

    const guard = new OrganizationGuard(prisma as never, cache as never);

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
    expect(cache.get).toHaveBeenCalledWith('org:access:org-1:user-1');
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });
});
