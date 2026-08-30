import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import {
  ClientInvitesController,
  ClientWorkspacesController,
  WhiteLabelController,
} from './white-label.controller';

type Ctor = new (...args: never[]) => unknown;
const handler = (ctor: Ctor, name: string) =>
  (ctor.prototype as Record<string, (...args: never[]) => unknown>)[name];

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on the named
 * handler (real Reflector, real class), so these tests fail if someone removes
 * a decorator or widens a role set. The membership role comes from the stubbed
 * database row, exactly where the guard is required to read it from.
 */
function roleGuard(ctor: Ctor, handlerName: string, membershipRole: string | null) {
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
    getHandler: () => handler(ctor, handlerName),
    getClass: () => ctor,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

const GATED: readonly (readonly [Ctor, string])[] = [
  [WhiteLabelController, 'update'],
  [ClientWorkspacesController, 'create'],
  [ClientInvitesController, 'create'],
  [ClientInvitesController, 'revoke'],
];

const OPEN: readonly (readonly [Ctor, string])[] = [
  [WhiteLabelController, 'get'],
  [ClientWorkspacesController, 'list'],
  [ClientWorkspacesController, 'usage'],
  [ClientInvitesController, 'list'],
];

describe('white-label controllers authorization', () => {
  it.each(GATED)('gates %o.%s to owner/admin', (ctor, name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(ctor, name))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(ctor, name))).toEqual({
      roles: ['owner', 'admin'],
      fresh: false,
    });
  });

  it.each(OPEN)('leaves %o.%s open to every member', (ctor, name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(ctor, name)) ?? []).not.toContain(
      RoleGuard,
    );
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(ctor, name))).toBeUndefined();
  });

  it.each([
    ['editor', ...GATED[0]],
    ['viewer', ...GATED[0]],
    ['editor', ...GATED[1]],
    ['viewer', ...GATED[1]],
    ['editor', ...GATED[2]],
    ['viewer', ...GATED[2]],
    ['editor', ...GATED[3]],
    ['viewer', ...GATED[3]],
  ] as const)('denies a %s on %o.%s', async (role, ctor, name) => {
    const { guard, ctx } = roleGuard(ctor, name, role);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s to revoke an invite', async (role) => {
    const { guard, ctx } = roleGuard(ClientInvitesController, 'revoke', role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /**
   * Reads the guard list off the class and method the way Nest composes them
   * and runs the request through it: drop RoleGuard from the decorator and the
   * handler gets reached, which is the regression to catch.
   */
  it('cannot be reached as an editor through the guards the controller binds', async () => {
    const createInvite = vi.fn();
    const controller = new ClientInvitesController({ createInvite } as never);
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, ClientInvitesController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler(ClientInvitesController, 'create')) ??
        []) as unknown[]),
    ];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

    const { guard, ctx } = roleGuard(ClientInvitesController, 'create', 'editor');
    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.create(
        'ws-1',
        { email: 'a@b.com', role: 'admin', expires_in_days: 14 },
        { id: 'user-1' } as never,
      );
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(createInvite).not.toHaveBeenCalled();
  });
});
