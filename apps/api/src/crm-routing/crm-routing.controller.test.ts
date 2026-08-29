import 'reflect-metadata';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CrmRoutingController } from './crm-routing.controller';
import { CreateCrmRoutingRuleDtoSchema } from './crm-routing.schemas';

const proto = CrmRoutingController.prototype;

/**
 * Runs RoleGuard against the REAL @RequiredRole metadata on the handler (real
 * Reflector, real class), so these tests fail if the decorator is removed or
 * its role set widened — see audit.controller.test.ts for the pattern.
 */
function guardContext(membershipRole: string | null) {
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
    getHandler: () => proto.createRule,
    getClass: () => CrmRoutingController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('CrmRoutingController authorization', () => {
  it('is protected by the workspace guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, CrmRoutingController) ?? [];

    expect(guards).toContain(WorkspaceGuard);
  });

  it('binds RoleGuard on createRule', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.createRule)).toEqual([RoleGuard]);
  });

  it('leaves listRules open to every member', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.listRules)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, proto.listRules)).toBeUndefined();
  });

  // createRule shipped with a raw @Body() and no validation; this pins the
  // pipe binding so deleting it cannot pass silently.
  it('validates the createRule body through a Zod pipe', () => {
    const args: Record<string, { pipes?: unknown[] }> =
      Reflect.getMetadata(ROUTE_ARGS_METADATA, CrmRoutingController, 'createRule') ?? {};
    const pipes = Object.values(args).flatMap((arg) => arg.pipes ?? []);

    expect(pipes.some((pipe) => pipe instanceof ZodValidationPipe)).toBe(true);
  });

  // The service audits rule creation with `actorUserId`, so the handler has to
  // forward the caller. Dropping the third argument leaves the audit row
  // anonymous while every other assertion here still passes.
  it('forwards the caller to the service so the audit row names an actor', async () => {
    const routing = { createRule: vi.fn(async () => ({ id: 'rule-1' })) };
    const controller = new CrmRoutingController(routing as never);
    const body = { keyword: 'dental', provider: 'pipedrive', action: 'primary' } as never;

    await controller.createRule('ws-1', body, { id: 'user-1' } as never);

    expect(routing.createRule).toHaveBeenCalledWith('ws-1', body, 'user-1');
  });

  it.each(['viewer', 'editor'] as const)('denies %s', async (role) => {
    const { guard, ctx } = guardContext(role);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s', async (role) => {
    const { guard, ctx } = guardContext(role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });
});

describe('CreateCrmRoutingRuleDtoSchema', () => {
  it('accepts a valid rule', () => {
    expect(CreateCrmRoutingRuleDtoSchema.safeParse({
      keyword: 'dental',
      provider: 'pipedrive',
      action: 'primary',
      agent_id: 'agent-1',
    }).success).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(CreateCrmRoutingRuleDtoSchema.safeParse({
      keyword: 'dental',
      provider: 'zoho',
      action: 'primary',
    }).success).toBe(false);
  });

  it('rejects a blank keyword and unknown keys', () => {
    expect(CreateCrmRoutingRuleDtoSchema.safeParse({
      keyword: '   ',
      provider: 'hubspot',
      action: 'secondary',
    }).success).toBe(false);

    expect(CreateCrmRoutingRuleDtoSchema.safeParse({
      keyword: 'dental',
      provider: 'hubspot',
      action: 'secondary',
      priority: 1,
    }).success).toBe(false);
  });
});
