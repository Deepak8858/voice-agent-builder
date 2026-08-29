import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { WorkspacesController } from './workspaces.controller';

function makeController() {
  const service = { update: vi.fn(async () => ({ id: 'ws-1', name: 'New' })) };
  return { service, controller: new WorkspacesController(service as never) };
}

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on `update`
 * (real Reflector, real class), so these tests fail if someone removes the
 * decorator or widens its role set — the properties the old inline check used
 * to pin. The membership role comes from the stubbed database row, exactly
 * where the guard is required to read it from.
 */
function roleGuard(membershipRole: string | null) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ params: { workspaceId: 'ws-1' }, user: { id: 'user-1' } }),
    }),
    getHandler: () => WorkspacesController.prototype.update,
    getClass: () => WorkspacesController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('WorkspacesController.update authorization', () => {
  it('gates the rename to owner/admin', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WorkspacesController.prototype.update)).toEqual([
      WorkspaceGuard,
      RoleGuard,
    ]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, WorkspacesController.prototype.update)).toEqual({
      roles: ['owner', 'admin'],
      fresh: false,
    });
  });

  it.each(['viewer', 'editor'] as const)('denies %s a rename', async (role) => {
    const { guard, ctx } = roleGuard(role);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s a rename', async (role) => {
    const { guard, ctx } = roleGuard(role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /**
   * Reads the guard list off the method the way Nest composes it and runs the
   * request through it: drop RoleGuard from the decorator and the handler gets
   * reached, which is the regression to catch.
   */
  it('cannot be reached as an editor through the bound guards', async () => {
    const { controller, service } = makeController();
    const bound = (Reflect.getMetadata(GUARDS_METADATA, WorkspacesController.prototype.update) ??
      []) as unknown[];

    const { guard, ctx } = roleGuard('editor');
    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.update('ws-1', { name: 'Renamed' }, { id: 'user-1' } as never);
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('passes the rename through for an authorized caller', async () => {
    const { controller, service } = makeController();

    await controller.update('ws-1', { name: 'Renamed' }, { id: 'user-1' } as never);

    expect(service.update).toHaveBeenCalledWith('ws-1', 'user-1', { name: 'Renamed' });
  });
});
