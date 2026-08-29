import { describe, expect, it, vi } from 'vitest';
import { CacheInvalidator } from './cache-invalidator';
import { workspaceAccessCacheKey } from './workspace.guard';
import { orgAccessCacheKey } from './organization.guard';

/**
 * The invalidators must delete the exact entries the guards read. These
 * assertions go through the guards' own key helpers, so a re-spelled key on
 * either side fails here instead of silently leaving revocation dead.
 */
describe('CacheInvalidator revocation keys', () => {
  function makeInvalidator() {
    const cache = { del: vi.fn(async () => undefined) };
    return { cache, invalidator: new CacheInvalidator(cache as never) };
  }

  it('invalidateWorkspaceAccess deletes the entry WorkspaceGuard/RoleGuard read', async () => {
    const { cache, invalidator } = makeInvalidator();
    await invalidator.invalidateWorkspaceAccess('ws-1', 'user-1');
    expect(cache.del).toHaveBeenCalledWith(workspaceAccessCacheKey('ws-1', 'user-1'));
  });

  it('invalidateOrgAccess deletes the entry OrganizationGuard reads', async () => {
    const { cache, invalidator } = makeInvalidator();
    await invalidator.invalidateOrgAccess('org-1', 'user-1');
    expect(cache.del).toHaveBeenCalledWith(orgAccessCacheKey('org-1', 'user-1'));
  });

  it('invalidateSession deletes every cache layer it is given', async () => {
    const { cache, invalidator } = makeInvalidator();
    await invalidator.invalidateSession({
      supabaseUserId: 'auth-1',
      appUserId: 'user-1',
      accessTokenHash: 'deadbeef',
    });
    expect(cache.del).toHaveBeenCalledWith('session:user:auth-1');
    expect(cache.del).toHaveBeenCalledWith('session:workspace:user-1');
    expect(cache.del).toHaveBeenCalledWith('session:claims:deadbeef');
  });

  it('invalidateWorkspaceList deletes the list read-through entry', async () => {
    const { cache, invalidator } = makeInvalidator();
    await invalidator.invalidateWorkspaceList('user-1');
    expect(cache.del).toHaveBeenCalledWith('workspaces:user:user-1');
  });
});
