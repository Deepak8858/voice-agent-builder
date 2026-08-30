import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@voiceforge/shared';
import { SettingsController, UpdateRetentionSchema } from './settings.controller';
import { RoleGuard } from '../common/role.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../common/errors';

/**
 * `PATCH v1/workspaces/me/retention` takes a number that decides how long call
 * recordings and transcripts survive. There is no global validation pipe in
 * this app (see main.ts - only filters and interceptors are registered), so the
 * body arrives exactly as the client sent it.
 *
 * The handler previously clamped with
 * `Math.min(3650, Math.max(30, body.retentionDays ?? 365))`. Every comparison
 * against `NaN` is false, so `Math.max(30, NaN)` is `NaN` and `"forever"`
 * propagated all the way to the workspace row, where it disables the retention
 * sweep entirely rather than shortening it. These tests pin the parse, since
 * the pipe is what stops that input at the edge.
 */

/**
 * Exercises the schema the controller actually binds, not a copy of it: a
 * duplicated schema here would keep passing after the real one was loosened.
 */
const pipe = new ZodValidationPipe(UpdateRetentionSchema);
const parseBody = (body: unknown) => pipe.transform(body, {} as never);

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const CALLER: SessionUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'caller@example.com',
  name: null,
  active_workspace_id: WORKSPACE_ID,
  active_workspace_role: 'owner',
  active_workspace_name: 'Own Workspace',
};

function makeController() {
  const retention = { updateWorkspaceRetention: vi.fn(async () => undefined) };
  return { retention, controller: new SettingsController(retention as never) };
}

describe('SettingsController.updateRetention body validation', () => {
  it('defaults to 365 days when retentionDays is omitted', () => {
    expect(parseBody({})).toEqual({ retentionDays: 365 });
  });

  it('accepts an in-range integer unchanged', () => {
    expect(parseBody({ retentionDays: 30 })).toEqual({ retentionDays: 30 });
    expect(parseBody({ retentionDays: 90 })).toEqual({ retentionDays: 90 });
    expect(parseBody({ retentionDays: 3650 })).toEqual({ retentionDays: 3650 });
  });

  /**
   * The regression case. Before validation these produced `NaN`, which the
   * clamp passed through untouched.
   */
  it.each([
    ['a non-numeric string', 'forever'],
    ['a numeric string', '100'],
    ['null', null],
    ['a boolean', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, retentionDays) => {
    expect(() => parseBody({ retentionDays })).toThrow(ValidationError);
  });

  it('rejects a fractional day count', () => {
    expect(() => parseBody({ retentionDays: 30.5 })).toThrow(ValidationError);
  });

  /**
   * Out-of-range input used to be silently rewritten to the nearest bound, so
   * a caller asking for 1 day of retention was quietly given 30 and a caller
   * asking for 4000 was quietly given 3650. Refusing says so.
   */
  it.each([
    ['below the minimum', 1],
    ['zero', 0],
    ['negative', -1],
    ['above the maximum', 4000],
  ])('rejects a value %s instead of clamping it', (_label, retentionDays) => {
    expect(() => parseBody({ retentionDays })).toThrow(ValidationError);
  });

  it('reports a 400 for rejected input', () => {
    try {
      parseBody({ retentionDays: 'forever' });
      throw new Error('expected ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).getStatus()).toBe(400);
      expect((err as ValidationError).errorCode).toBe('VALIDATION_ERROR');
    }
  });
});

describe('SettingsController.updateRetention', () => {
  it('writes the validated value against the session workspace', async () => {
    const { retention, controller } = makeController();

    const result = await controller.updateRetention(CALLER, parseBody({ retentionDays: 90 }));

    expect(retention.updateWorkspaceRetention).toHaveBeenCalledWith(WORKSPACE_ID, 90);
    expect(result).toEqual({ success: true, retentionDays: 90 });
  });

  it('applies the 365-day default when the field is omitted', async () => {
    const { retention, controller } = makeController();

    const result = await controller.updateRetention(CALLER, parseBody({}));

    expect(retention.updateWorkspaceRetention).toHaveBeenCalledWith(WORKSPACE_ID, 365);
    expect(result).toEqual({ success: true, retentionDays: 365 });
  });

  it('refuses an unauthenticated caller', async () => {
    const { retention, controller } = makeController();

    await expect(controller.updateRetention(undefined, parseBody({}))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(retention.updateWorkspaceRetention).not.toHaveBeenCalled();
  });

  it('refuses a session with no active workspace', async () => {
    const { retention, controller } = makeController();

    await expect(
      controller.updateRetention({ ...CALLER, active_workspace_id: null }, parseBody({})),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(retention.updateWorkspaceRetention).not.toHaveBeenCalled();
  });
});

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on the handler
 * (real Reflector, real class). The session claims `owner` in every case
 * below; the membership row is what must decide — on this @SessionScoped()
 * route `active_workspace_role` is the caller's oldest membership, not their
 * seat here.
 */
function roleGuardContext(dbRole: string | null, user: SessionUser | null = CALLER) {
  const prisma = {
    membership: { findUnique: vi.fn(async () => (dbRole ? { role: dbRole } : null)) },
  };
  const cache = {
    // A stale entry that would admit the caller if the guard consulted it;
    // the route declares `fresh`, so it must not.
    get: vi.fn(async () => ({ role: 'admin', name: 'Own Workspace' })),
    set: vi.fn(async () => undefined),
  };
  const req = { params: {}, ...(user === null ? {} : { user }) };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => SettingsController.prototype.updateRetention,
    getClass: () => SettingsController,
  };
  return { prisma, cache, guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('SettingsController.updateRetention authorization', () => {
  it.each(['editor', 'viewer'] as const)('denies %s', async (role) => {
    const { guard, ctx } = roleGuardContext(role);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s', async (role) => {
    const { guard, ctx } = roleGuardContext(role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it('resolves the seat in the session workspace, skipping the role cache', async () => {
    const { guard, ctx, prisma, cache } = roleGuardContext('owner');

    await guard.canActivate(ctx as never);

    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: CALLER.id, workspaceId: WORKSPACE_ID } },
      select: { role: true },
    });
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('denies a caller with no membership in the session workspace', async () => {
    const { guard, ctx } = roleGuardContext(null);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('denies a session with no active workspace', async () => {
    const { guard, ctx } = roleGuardContext('owner', { ...CALLER, active_workspace_id: null });

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  /**
   * Reads the guard list off the method and runs it the way Nest does, so
   * deleting `@UseGuards(RoleGuard)` from the route fails here even though
   * every other test builds the guard by hand.
   */
  it('cannot be reached as an editor through the guards the route binds', async () => {
    const { guard, ctx } = roleGuardContext('editor');
    const { retention, controller } = makeController();
    const bound = (Reflect.getMetadata(GUARDS_METADATA, SettingsController.prototype.updateRetention) ??
      []) as unknown[];

    expect(bound).toEqual([RoleGuard]);

    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.updateRetention(CALLER, parseBody({ retentionDays: 30 }));
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(retention.updateWorkspaceRetention).not.toHaveBeenCalled();
  });
});
