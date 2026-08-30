import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { OutboundCampaignController } from './outbound-campaign.controller';

const MUTATIONS = ['create', 'start', 'pause'] as const;
const READS = ['list', 'get', 'getStats'] as const;

const handler = (name: string) =>
  (OutboundCampaignController.prototype as unknown as Record<string, (...args: never[]) => unknown>)[name];

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on the named
 * handler (real Reflector, real class). The membership role comes from the
 * stubbed database row; `cachedRole` seeds the workspace-access cache so the
 * fresh-vs-cached behavior of `start` is observable.
 */
function roleGuard(handlerName: string, membershipRole: string | null, cachedRole?: string) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = {
    get: vi.fn(async () => (cachedRole ? { role: cachedRole } : null)),
    set: vi.fn(async () => undefined),
  };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ params: { workspaceId: 'ws-1' }, user: { id: 'user-1' } }),
    }),
    getHandler: () => handler(handlerName),
    getClass: () => OutboundCampaignController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx, cache };
}

describe('OutboundCampaignController authorization', () => {
  it.each(['create', 'pause'] as const)('gates %s to owner/admin', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toEqual({
      roles: ['owner', 'admin'],
      fresh: false,
    });
  });

  it('gates start to owner/admin with a fresh role read', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('start'))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler('start'))).toEqual({
      roles: ['owner', 'admin'],
      fresh: true,
    });
  });

  it.each(READS)('leaves %s open to every member', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []).not.toContain(RoleGuard);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toBeUndefined();
  });

  it.each(MUTATIONS)('denies an editor on %s', async (name) => {
    const { guard, ctx } = roleGuard(name, 'editor');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s to create', async (role) => {
    const { guard, ctx } = roleGuard('create', role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  // The demoted-admin window `fresh` exists to close: the cache still says
  // admin, the membership row says editor, and start must believe the row.
  it('denies start on a stale cached admin role', async () => {
    const { guard, ctx, cache } = roleGuard('start', 'editor', 'admin');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
    expect(cache.get).not.toHaveBeenCalled();
  });

  /**
   * Reads the guard list off the class and method the way Nest composes them
   * and runs the request through it: drop RoleGuard from the decorator and the
   * handler gets reached, which is the regression to catch.
   */
  it('cannot be reached as an editor through the guards the controller binds', async () => {
    const start = vi.fn();
    const controller = new OutboundCampaignController({ start } as never);
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, OutboundCampaignController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler('start')) ?? []) as unknown[]),
    ];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

    const { guard, ctx } = roleGuard('start', 'editor');
    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.start('ws-1', 'camp-1', { id: 'user-1' } as never);
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(start).not.toHaveBeenCalled();
  });
});
