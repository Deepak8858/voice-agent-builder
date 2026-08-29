import { describe, expect, it, vi } from 'vitest';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService.update', () => {
  it('revokes list, access and session caches for every member, not just the actor', async () => {
    const members = [{ userId: 'u-actor' }, { userId: 'u-other' }];
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

    // Every member's sidebar list, workspace:access entry and session
    // snapshot cache the old name; a rename must clear all of them.
    for (const { userId } of members) {
      expect(invalidator.invalidateWorkspaceList).toHaveBeenCalledWith(userId);
      expect(invalidator.invalidateWorkspaceAccess).toHaveBeenCalledWith('ws-1', userId);
      expect(invalidator.invalidateSession).toHaveBeenCalledWith({ appUserId: userId });
    }
  });
});
