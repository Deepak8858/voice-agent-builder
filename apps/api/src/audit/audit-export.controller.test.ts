import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ORG_ROLE_KEY } from '../common/decorators/required-org-role.decorator';
import { ForbiddenError } from '../common/errors';
import { OrganizationGuard } from '../common/organization.guard';
import { AuditExportController } from './audit-export.controller';

/**
 * `GET v1/orgs/:orgId/audit-logs` returns up to 10k rows of actor user ids,
 * actions, resource types and resource ids for EVERY workspace in the org.
 * Membership is modelled per workspace, so before @RequiredOrgRole any `viewer`
 * in any one workspace of the org could read all of it, including workspaces
 * they are not a member of.
 *
 * These run the REAL OrganizationGuard with the REAL Reflector against the REAL
 * decorator on the REAL handler, so deleting @RequiredOrgRole from the
 * controller fails them — constructing the guard around hand-written metadata
 * would not.
 */
const handler = AuditExportController.prototype.getOrgAuditLogs;

const USER = {
  id: 'user-1',
  email: 'member@example.com',
  name: null,
  active_workspace_id: 'ws-1',
  active_workspace_name: 'Workspace',
  // Deliberately an `owner` seat in the SESSION workspace while the seat that
  // matters lives in `rows`. A guard that read this field instead of resolving
  // the org would admit every caller.
  active_workspace_role: 'owner' as const,
};

/** Queries the given rows, so the org predicate and the role filter both run. */
function prismaFor(rows: { orgId: string; role: string }[], ownedOrgIds: string[] = []) {
  return {
    membership: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        rows.some(
          (r) =>
            r.orgId === where.workspace.organizationId &&
            (!where.role || where.role.in.includes(r.role)),
        )
          ? { id: 'membership-1' }
          : null,
      ),
    },
    organization: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        ownedOrgIds.includes(where.id) ? { id: where.id } : null,
      ),
    },
  };
}

function contextFor(orgId: string) {
  const req = { params: { orgId }, headers: {}, user: USER };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => AuditExportController,
  };
}

function guardFor(prisma: ReturnType<typeof prismaFor>) {
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  return new OrganizationGuard(prisma as never, cache as never, new Reflector());
}

describe('AuditExportController org audit-log authorization', () => {
  it('binds OrganizationGuard on the handler', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([OrganizationGuard]);
  });

  it('declares the administrative seats that may read the log', () => {
    expect(Reflect.getMetadata(REQUIRED_ORG_ROLE_KEY, handler)).toEqual(['owner', 'admin']);
  });

  it.each(['owner', 'admin'] as const)('admits a %s in a workspace of the org', async (role) => {
    const prisma = prismaFor([{ orgId: 'org-1', role }]);

    await expect(guardFor(prisma).canActivate(contextFor('org-1') as never)).resolves.toBe(true);
  });

  it.each(['viewer', 'editor'] as const)('refuses a %s in a workspace of the org', async (role) => {
    const prisma = prismaFor([{ orgId: 'org-1', role }]);

    await expect(
      guardFor(prisma).canActivate(contextFor('org-1') as never),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  // An owner who never joined a workspace still administers their own org.
  it('admits the organization owner with no membership row at all', async () => {
    const prisma = prismaFor([], ['org-1']);

    await expect(guardFor(prisma).canActivate(contextFor('org-1') as never)).resolves.toBe(true);
  });

  // The tenant half, still enforced: an owner seat elsewhere is not a seat here.
  it('refuses an owner of a different organization', async () => {
    const prisma = prismaFor([{ orgId: 'org-2', role: 'owner' }], ['org-2']);

    await expect(
      guardFor(prisma).canActivate(contextFor('org-1') as never),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
