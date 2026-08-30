import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { GenerationRateLimitGuard } from '../common/generation-rate-limit.guard';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { AgentsController } from './agents.controller';

const MUTATIONS = ['create', 'generate', 'update', 'createVersion', 'publish', 'pause', 'updateFlow'] as const;
const READS = ['list', 'get'] as const;

const handler = (name: string) =>
  (AgentsController.prototype as unknown as Record<string, (...args: never[]) => unknown>)[name];

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
    getClass: () => AgentsController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('AgentsController authorization', () => {
  it.each(MUTATIONS)('gates %s to owner/admin/editor', (name) => {
    const guards = name === 'generate' ? [RoleGuard, GenerationRateLimitGuard] : [RoleGuard];
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual(guards);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toEqual({
      roles: ['owner', 'admin', 'editor'],
      fresh: false,
    });
  });

  it.each(READS)('leaves %s open to every member', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []).not.toContain(RoleGuard);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toBeUndefined();
  });

  it.each(MUTATIONS)('denies a viewer on %s', async (name) => {
    const { guard, ctx } = roleGuard(name, 'viewer');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin', 'editor'] as const)('allows %s to create', async (role) => {
    const { guard, ctx } = roleGuard('create', role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /**
   * Every other test here builds a RoleGuard by hand, so all of them stay
   * green if the @UseGuards binding is deleted. This one reads the guard list
   * off the class and method the way Nest composes them (class guards first)
   * and runs the request through it: drop RoleGuard from the decorator and the
   * handler gets reached, which is the regression to catch.
   */
  it('cannot be reached as a viewer through the guards the controller binds', async () => {
    const create = vi.fn();
    const controller = new AgentsController({ create } as never, {} as never);
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, AgentsController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler('create')) ?? []) as unknown[]),
    ];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

    const { guard, ctx } = roleGuard('create', 'viewer');
    const request = async () => {
      for (const Bound of bound) {
        // WorkspaceGuard's own membership check is covered by its own tests;
        // here it stands in as "the caller is a member" so the only thing that
        // can refuse the request is the role gate.
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.create('ws-1', { name: 'Agent' } as never, { id: 'user-1' } as never);
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(create).not.toHaveBeenCalled();
  });
});
