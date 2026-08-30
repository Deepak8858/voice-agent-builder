import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ComplianceController } from './compliance.controller';

const handler = (name: string) =>
  (ComplianceController.prototype as unknown as Record<string, (...args: never[]) => unknown>)[name];

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on the named
 * handler (real Reflector, real class), so these tests fail if someone removes
 * a decorator or widens a role set. The membership role comes from the stubbed
 * database row, exactly where the guard is required to read it from.
 */
function roleGuard(handlerName: string, membershipRole: string | null) {
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
    getHandler: () => handler(handlerName),
    getClass: () => ComplianceController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('ComplianceController DNC authorization', () => {
  it.each(['addDnc', 'removeDnc'] as const)('gates %s to owner/admin', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toEqual({
      roles: ['owner', 'admin'],
      fresh: false,
    });
  });

  it.each(['check', 'listDnc'] as const)('leaves %s open to every member', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []).not.toContain(RoleGuard);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toBeUndefined();
  });

  it.each([
    ['editor', 'addDnc'],
    ['editor', 'removeDnc'],
    ['viewer', 'addDnc'],
    ['viewer', 'removeDnc'],
  ] as const)('denies a %s on %s', async (role, name) => {
    const { guard, ctx } = roleGuard(name, role);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s to removeDnc', async (role) => {
    const { guard, ctx } = roleGuard('removeDnc', role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /**
   * Reads the guard list off the class and method the way Nest composes them
   * and runs the request through it: drop RoleGuard from the decorator and the
   * handler gets reached, which is the regression to catch.
   */
  it('cannot be reached as an editor through the guards the controller binds', async () => {
    const removeDnc = vi.fn();
    const controller = new ComplianceController({ removeDnc } as never);
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, ComplianceController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler('removeDnc')) ?? []) as unknown[]),
    ];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

    const { guard, ctx } = roleGuard('removeDnc', 'editor');
    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.removeDnc('ws-1', '+15550100', { id: 'user-1' } as never);
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(removeDnc).not.toHaveBeenCalled();
  });
});
