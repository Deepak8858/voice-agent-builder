import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ToolsController } from './tools.controller';

const proto = ToolsController.prototype;

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on each handler
 * (real Reflector, real class), so these fail if a decorator is removed or its
 * role set widened. The session claims `owner` throughout; the membership row
 * is what must decide.
 */
function guardContext(handler: unknown, membershipRole: string | null) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const req = {
    params: { workspaceId: 'ws-1' },
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      active_workspace_id: 'ws-1',
      active_workspace_name: 'Workspace',
      active_workspace_role: 'owner',
    },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => ToolsController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('ToolsController role gates', () => {
  it('binds WorkspaceGuard on the class and RoleGuard on every mutating route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ToolsController)).toEqual([WorkspaceGuard]);
    for (const handler of [proto.create, proto.update, proto.remove, proto.invoke]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RoleGuard]);
    }
    for (const handler of [proto.list, proto.get, proto.listInvocations]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    }
  });

  // Tool CRUD is tenant configuration (endpoints, credential references), so
  // editors are refused there but keep the invoke/test button.
  it.each([
    ['create', proto.create],
    ['update', proto.update],
    ['remove', proto.remove],
  ] as const)('denies an editor on %s', async (_name, handler) => {
    const { guard, ctx } = guardContext(handler, 'editor');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s on create', async (role) => {
    const { guard, ctx } = guardContext(proto.create, role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it('allows an editor on invoke', async () => {
    const { guard, ctx } = guardContext(proto.invoke, 'editor');

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it.each([
    ['create', proto.create],
    ['update', proto.update],
    ['remove', proto.remove],
    ['invoke', proto.invoke],
  ] as const)('denies a viewer on %s', async (_name, handler) => {
    const { guard, ctx } = guardContext(handler, 'viewer');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  /**
   * Reads the guard lists off the class and the method and runs them the way
   * Nest does, so deleting RoleGuard from a route's @UseGuards fails here even
   * though every other test builds the guard by hand.
   */
  it('cannot invoke a tool as a viewer through the guards the route binds', async () => {
    const { guard, ctx } = guardContext(proto.invoke, 'viewer');
    const invoke = vi.fn(async () => ({}));
    const controller = new ToolsController({ invoke } as never);
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, ToolsController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, proto.invoke) ?? []) as unknown[]),
    ];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

    const request = async () => {
      for (const Bound of bound) {
        // WorkspaceGuard's membership check is covered by its own tests; here
        // it stands in as "the caller is a member" so only the role gate can
        // refuse the request.
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.invoke('ws-1', 'tool-1', { arguments: {} }, {
        id: 'user-1',
      } as never);
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(invoke).not.toHaveBeenCalled();
  });
});
