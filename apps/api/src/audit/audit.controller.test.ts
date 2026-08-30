import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../common/errors';
import { AuditController } from './audit.controller';

function request(role: SessionUser['active_workspace_role']): Request {
  return {
    user: { id: 'user-1', active_workspace_role: role, active_workspace_id: 'ws-1' },
  } as unknown as Request;
}

/** Returns `take` rows so `logs.length > take` is never true. */
function makeController(rowCount = 3) {
  const findMany = vi.fn(async ({ take }: { take: number }) =>
    Array.from({ length: Math.min(rowCount, Math.max(take, 0)) }, (_, i) => ({ id: `log-${i}` })),
  );
  return { findMany, controller: new AuditController({ auditLog: { findMany } } as never) };
}

describe('AuditController.list authorization', () => {
  it.each(['viewer', 'editor'] as const)('denies %s', async (role) => {
    const { controller, findMany } = makeController();

    await expect(controller.list('ws-1', request(role), undefined, undefined, undefined))
      .rejects.toBeInstanceOf(ForbiddenError);
    // The actor emails must not even be read, let alone serialized.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('denies a request the guard never populated', async () => {
    const { controller } = makeController();

    await expect(controller.list('ws-1', {} as Request, undefined, undefined, undefined))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin'] as const)('allows %s', async (role) => {
    const { controller, findMany } = makeController();

    const res = await controller.list('ws-1', request(role), undefined, undefined, undefined);

    expect(res.items).toHaveLength(3);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'ws-1' } }));
  });
});

describe('AuditController.list limit clamping', () => {
  const takeFor = async (limit: string | undefined): Promise<number> => {
    const { controller, findMany } = makeController();
    await controller.list('ws-1', request('owner'), undefined, limit, undefined);
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

    const res = await controller.list('ws-1', request('owner'), undefined, '-2', undefined);

    expect(res.items).toHaveLength(1);
    expect(res.next_cursor).toBe('log-0');
  });
});
