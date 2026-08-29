import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { AuditController } from './audit.controller';

/** Returns `take` rows so `logs.length > take` is never true. */
function makeController(rowCount = 3) {
  const findMany = vi.fn(async ({ take }: { take: number }) =>
    Array.from({ length: Math.min(rowCount, Math.max(take, 0)) }, (_, i) => ({ id: `log-${i}` })),
  );
  return { findMany, controller: new AuditController({ auditLog: { findMany } } as never) };
}

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on
 * AuditController (real Reflector, real class), so this fails if someone
 * removes the decorator or widens its role set — the properties the old
 * inline check used to pin. The membership role comes from the stubbed
 * database row, exactly where the guard is required to read it from.
 */
function guardContext(membershipRole: string | null, user?: Record<string, unknown> | null) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const req = {
    params: { workspaceId: 'ws-1' },
    ...(user === null
      ? {}
      : {
          user: user ?? {
            id: 'user-1',
            email: 'user@example.com',
            name: null,
            active_workspace_id: 'ws-1',
            active_workspace_name: 'Workspace',
            active_workspace_role: membershipRole,
          },
        }),
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => AuditController.prototype.list,
    getClass: () => AuditController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('AuditController.list authorization', () => {
  it.each(['viewer', 'editor'] as const)('denies %s', async (role) => {
    const { guard, ctx } = guardContext(role);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('denies a request the guard never populated', async () => {
    const { guard, ctx } = guardContext('owner', null);

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('denies a caller with no membership in the workspace', async () => {
    const { guard, ctx } = guardContext(null, {
      id: 'user-1',
      active_workspace_id: 'ws-1',
      active_workspace_role: 'owner',
    });

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s', async (role) => {
    const { guard, ctx } = guardContext(role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /**
   * The handler used to re-check the role itself, so it was self-defending;
   * now `@UseGuards(WorkspaceGuard, RoleGuard)` is the only thing between a
   * `viewer` and every audit row's actor email. Every other test here builds a
   * RoleGuard by hand, so all of them stay green if that binding is deleted.
   * This one reads the guard list off the class and runs it the way Nest does:
   * drop RoleGuard from the decorator and the handler gets reached, which is
   * the regression to catch.
   */
  it('cannot be reached as a viewer through the guards the controller binds', async () => {
    const { guard, ctx } = guardContext('viewer');
    const { controller, findMany } = makeController();
    const bound = (Reflect.getMetadata(GUARDS_METADATA, AuditController) ?? []) as unknown[];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

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
      return controller.list('ws-1', undefined, undefined, undefined);
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('scopes the query to the workspace in the URL', async () => {
    const { controller, findMany } = makeController();

    const res = await controller.list('ws-1', undefined, undefined, undefined);

    expect(res.items).toHaveLength(3);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'ws-1' } }));
  });
});

describe('AuditController.list limit clamping', () => {
  const takeFor = async (limit: string | undefined): Promise<number> => {
    const { controller, findMany } = makeController();
    await controller.list('ws-1', undefined, limit, undefined);
    return (findMany.mock.calls[0][0] as { take: number }).take - 1;
  };

  it.each([
    ['default', undefined, 20],
    ['explicit', '5', 5],
    ['above the cap', '5000', 100],
    ['negative', '-2', 1],
    ['zero', '0', 20],
    ['not a number', 'all', 20],
  ])('clamps a %s limit', async (_name, limit, expected) => {
    expect(await takeFor(limit as string | undefined)).toBe(expected);
  });

  // `take: -1` made Prisma page backwards from the cursor and return a row for
  // what should have been an empty page, so `items[items.length - 1].id` threw.
  it('serves a negative limit as the smallest page instead of throwing', async () => {
    const { controller } = makeController();

    const res = await controller.list('ws-1', undefined, '-2', undefined);

    expect(res.items).toHaveLength(1);
    expect(res.next_cursor).toBe('log-0');
  });
});
