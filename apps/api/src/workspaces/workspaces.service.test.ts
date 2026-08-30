import { describe, expect, it, vi } from 'vitest';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService.update', () => {
  it('revokes list, access and session caches for every member, not just the actor', async () => {
    // The second member has no Supabase identity yet (`authUserId` is nullable),
    // so the subject-keyed key must simply be skipped for them.
    const members = [
      { userId: 'u-actor', user: { authUserId: 'auth-actor' } },
      { userId: 'u-other', user: { authUserId: null } },
    ];
    const prisma = {
      workspace: {
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => ({
          id: where.id,
          ...data,
        })),
      },
      membership: { findMany: vi.fn(async () => members) },
    };
    const audit = { log: vi.fn(async () => undefined) };
    const cache = { readThrough: vi.fn(), del: vi.fn() };
    const invalidator = {
      invalidateWorkspaceList: vi.fn(async () => undefined),
      invalidateWorkspaceAccess: vi.fn(async () => undefined),
      invalidateSession: vi.fn(async () => undefined),
    };
    const svc = new WorkspacesService(
      prisma as never,
      audit as never,
      cache as never,
      invalidator as never,
    );

    await svc.update('ws-1', 'u-actor', { name: 'Renamed' });

    // Every member's sidebar list, workspace:access entry and BOTH session
    // snapshots cache the old name; a rename must clear all of them. The
    // subject-keyed session:user entry is the one getSessionUser reads first.
    for (const { userId, user } of members) {
      expect(invalidator.invalidateWorkspaceList).toHaveBeenCalledWith(userId);
      expect(invalidator.invalidateWorkspaceAccess).toHaveBeenCalledWith('ws-1', userId);
      expect(invalidator.invalidateSession).toHaveBeenCalledWith({
        appUserId: userId,
        supabaseUserId: user.authUserId ?? undefined,
      });
    }
    expect(prisma.membership.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      select: { userId: true, user: { select: { authUserId: true } } },
    });
  });
});
