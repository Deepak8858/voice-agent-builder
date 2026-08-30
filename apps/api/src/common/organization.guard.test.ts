import { describe, expect, it, vi } from 'vitest';
import { OrganizationGuard } from './organization.guard';
import { REQUIRED_ORG_ROLE_KEY } from './decorators/required-org-role.decorator';
import { ForbiddenError, UnauthorizedError } from './errors';

function contextFor(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  };
}

/**
 * Stands in for Nest's Reflector, returning fixed @RequiredOrgRole metadata.
 * `undefined` is a route that declares no seat, which must stay open to any
 * member — see audit-export.controller.test.ts for the tests that run the real
 * Reflector against the real decorator on the real handler.
 */
function reflectorStub(roles?: readonly string[]) {
  return {
    getAllAndOverride: vi.fn((key: string) => (key === REQUIRED_ORG_ROLE_KEY ? roles : undefined)),
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

    const guard = new OrganizationGuard(prisma as never, cache as never, reflectorStub() as never);

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

    const guard = new OrganizationGuard(prisma as never, cacheStub() as never, reflectorStub() as never);

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

    const guard = new OrganizationGuard(prisma as never, cache as never, reflectorStub() as never);

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before touching the database', async () => {
    const prisma = prismaStub();
    const req = { params: { orgId: 'org-1' }, headers: {} };

    const guard = new OrganizationGuard(prisma as never, cacheStub() as never, reflectorStub() as never);

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

    const guard = new OrganizationGuard(prisma as never, cacheStub() as never, reflectorStub() as never);

    await expect(guard.canActivate(contextFor(req) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
  });

  it('serves a cached grant without re-querying membership', async () => {
    const prisma = prismaStub();
    const cache = cacheStub(true);
    const req = { params: { orgId: 'org-1' }, headers: {}, user: MEMBER };

    const guard = new OrganizationGuard(prisma as never, cache as never, reflectorStub() as never);

    await expect(guard.canActivate(contextFor(req) as never)).resolves.toBe(true);
    expect(cache.get).toHaveBeenCalledWith('org:access:org-1:user-1');
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });
});

describe('OrganizationGuard @RequiredOrgRole', () => {
  const req = () => ({ params: { orgId: 'org-1' }, headers: {}, user: MEMBER });

  it('narrows the membership lookup to the declared roles', async () => {
    const prisma = prismaStub({ membership: { id: 'membership-1' } });
    const guard = new OrganizationGuard(
      prisma as never,
      cacheStub() as never,
      reflectorStub(['owner', 'admin']) as never,
    );

    await expect(guard.canActivate(contextFor(req()) as never)).resolves.toBe(true);
    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        workspace: { organizationId: 'org-1' },
        role: { in: ['owner', 'admin'] },
      },
      select: { id: true },
    });
  });

  // A viewer/editor holds a membership in the org but no matching role, so the
  // role-filtered lookup misses and the ownership fallback is their last chance.
  it('refuses a member whose only seat is outside the allow-list', async () => {
    const prisma = prismaStub({ membership: null, organization: null });
    const cache = cacheStub();
    const guard = new OrganizationGuard(
      prisma as never,
      cache as never,
      reflectorStub(['owner', 'admin']) as never,
    );

    await expect(guard.canActivate(contextFor(req()) as never)).rejects.toThrow(
      /role in this organization does not permit/,
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('admits the organization owner even with no qualifying membership', async () => {
    const prisma = prismaStub({ membership: null, organization: { id: 'org-1' } });
    const guard = new OrganizationGuard(
      prisma as never,
      cacheStub() as never,
      reflectorStub(['owner', 'admin']) as never,
    );

    await expect(guard.canActivate(contextFor(req()) as never)).resolves.toBe(true);
  });

  /**
   * The privilege escalation this route would otherwise ship with: the
   * `org:access` entry is a bare `true` recording membership with no role in it,
   * so serving a role-gated route from it would let any viewer who touched a
   * membership-only org route reach the audit log for the rest of the TTL.
   */
  it('ignores the bare-membership cache entry and re-reads the row', async () => {
    const prisma = prismaStub({ membership: null, organization: null });
    const cache = cacheStub(true);
    const guard = new OrganizationGuard(
      prisma as never,
      cache as never,
      reflectorStub(['owner', 'admin']) as never,
    );

    await expect(guard.canActivate(contextFor(req()) as never)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(prisma.membership.findFirst).toHaveBeenCalled();
  });

  // Absent metadata must NOT fail closed: the guard is bound to routes that
  // legitimately need no seat, and the query must stay unfiltered.
  it('leaves a route with no @RequiredOrgRole open to any member', async () => {
    const prisma = prismaStub({ membership: { id: 'membership-1' } });
    const guard = new OrganizationGuard(
      prisma as never,
      cacheStub() as never,
      reflectorStub(undefined) as never,
    );

    await expect(guard.canActivate(contextFor(req()) as never)).resolves.toBe(true);
    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', workspace: { organizationId: 'org-1' } },
      select: { id: true },
    });
  });

  // The mirror: an empty list declares a gate and names nobody, which reads as
  // applied in review while admitting everyone. That fails closed.
  it('fails closed on @RequiredOrgRole() with no roles', async () => {
    const prisma = prismaStub({ membership: { id: 'membership-1' } });
    const guard = new OrganizationGuard(
      prisma as never,
      cacheStub() as never,
      reflectorStub([]) as never,
    );

    await expect(guard.canActivate(contextFor(req()) as never)).rejects.toThrow(
      /declares no allowed roles/,
    );
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
  });
});
