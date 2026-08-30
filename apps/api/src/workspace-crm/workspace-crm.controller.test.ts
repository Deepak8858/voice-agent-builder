import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { WorkspaceCrmController } from './workspace-crm.controller';

const proto = WorkspaceCrmController.prototype;
const MUTATIONS = ['create', 'update', 'delete', 'test'] as const;

/**
 * Runs RoleGuard against the REAL @RequiredRole metadata on the handler (real
 * Reflector, real class), so these tests fail if the decorator is removed or
 * its role set widened — see audit.controller.test.ts for the pattern.
 */
function guardContext(membershipRole: string | null, handler: unknown) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const req = {
    params: { workspaceId: 'ws-1' },
    user: { id: 'user-1', active_workspace_id: 'ws-1', active_workspace_role: membershipRole },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => WorkspaceCrmController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('WorkspaceCrmController authorization', () => {
  it('is protected by the workspace guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, WorkspaceCrmController) ?? [];

    expect(guards).toContain(WorkspaceGuard);
  });

  it.each(MUTATIONS)('binds RoleGuard on %s', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[name])).toEqual([RoleGuard]);
  });

  it('leaves the list open to every member', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.list)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, proto.list)).toBeUndefined();
  });

  describe.each(MUTATIONS)('%s', (name) => {
    it.each(['viewer', 'editor'] as const)('denies %s', async (role) => {
      const { guard, ctx } = guardContext(role, proto[name]);

      await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it.each(['owner', 'admin'] as const)('allows %s', async (role) => {
      const { guard, ctx } = guardContext(role, proto[name]);

      await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
    });
  });
});
