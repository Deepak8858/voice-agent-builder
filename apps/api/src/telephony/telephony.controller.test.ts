import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { TelephonyController } from './telephony.controller';

const proto = TelephonyController.prototype;
const MUTATIONS = [
  'createConnection',
  'syncNumbers',
  'importNumbers',
  'manualNumber',
  'assignAgent',
  'configureLiveKit',
  'disconnect',
  'startOutbound',
] as const;
const READS = ['providers', 'listConnections', 'listPhoneNumbers'] as const;

/**
 * Runs RoleGuard against the REAL @RequiredRole metadata on the handler (real
 * Reflector, real class), so these tests fail if a decorator is removed or its
 * role set widened — see audit.controller.test.ts for the pattern.
 */
function guardContext(
  membershipRole: string | null,
  handler: unknown,
  cachedRole: string | null = null,
) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = {
    get: vi.fn(async () => (cachedRole ? { role: cachedRole } : null)),
    set: vi.fn(async () => undefined),
  };
  const req = {
    params: { workspaceId: 'ws-1' },
    user: { id: 'user-1', active_workspace_id: 'ws-1', active_workspace_role: membershipRole },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => TelephonyController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('TelephonyController authorization', () => {
  it('is protected by the workspace guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, TelephonyController) ?? [];

    expect(guards).toContain(WorkspaceGuard);
  });

  it.each(MUTATIONS)('binds RoleGuard on %s', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[name])).toEqual([RoleGuard]);
  });

  it.each(READS)('leaves %s open to every member', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[name])).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, proto[name])).toBeUndefined();
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

  // Outbound calls spend minutes, so a demoted admin must not ride the 300s
  // workspace-access cache into one; the other mutations accept that window.
  it('ignores the cached role when starting an outbound call', async () => {
    const { guard, ctx } = guardContext('viewer', proto.startOutbound, 'admin');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('trusts the cached role on the other mutations', async () => {
    const { guard, ctx } = guardContext('viewer', proto.createConnection, 'admin');

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });
});
