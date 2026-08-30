import { Injectable, Optional } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { ResponseCacheService } from '../cache/response-cache.service';
import {
  sessionClaimsCacheKey,
  sessionUserCacheKey,
  sessionWorkspaceCacheKey,
  workspaceListCacheKey,
} from './cache-keys';
import { orgAccessCacheKey } from './organization.guard';
// The guards own their key spelling; deleting anything but the exact entry
// they write leaves a revoked role live for a full TTL window.
import { workspaceAccessCacheKey } from './workspace.guard';

/**
 * Centralized cache invalidation service. Provides semantic methods for
 * invalidating cache entries rather than scattered inline cache.del() calls.
 */
@Injectable()
export class CacheInvalidator {
  constructor(
    private readonly cache: CacheService,
    // Optional so the many unit tests that construct services with a bare
    // invalidator stub keep working, and so a missing provider degrades to
    // "entries expire on their TTL" rather than a boot failure.
    @Optional() private readonly responseCache?: ResponseCacheService,
  ) {}

  async invalidateAgentList(workspaceId: string) {
    await this.cache.del(`agents:list:${workspaceId}`);
    // Agent mutations change what every member of the workspace should see,
    // so bump the whole workspace's response-cache generation as well.
    await this.responseCache?.invalidateWorkspace(workspaceId);
  }

  invalidateWorkspaceList(userId: string) {
    return this.cache.del(workspaceListCacheKey(userId));
  }

  invalidateWorkspaceAccess(workspaceId: string, userId: string) {
    return this.cache.del(workspaceAccessCacheKey(workspaceId, userId));
  }

  invalidateOrgAccess(orgId: string, userId: string) {
    return this.cache.del(orgAccessCacheKey(orgId, userId));
  }

  async invalidateSession(input: {
    supabaseUserId?: string;
    appUserId?: string;
    accessTokenHash?: string;
  }) {
    if (input.supabaseUserId) {
      await this.cache.del(sessionUserCacheKey(input.supabaseUserId));
    }
    if (input.appUserId) {
      await this.cache.del(sessionWorkspaceCacheKey(input.appUserId));
    }
    if (input.accessTokenHash) {
      await this.cache.del(sessionClaimsCacheKey(input.accessTokenHash));
    }
  }

  async invalidateCallList(workspaceId: string, agentId?: string | null) {
    await this.cache.del(`calls:list:${workspaceId}:all`);
    if (agentId) await this.cache.del(`calls:list:${workspaceId}:${agentId}`);
  }

  invalidateTemplates() {
    return this.cache.del('templates:list:public');
  }

  invalidateBillingSubscription(organizationId: string) {
    return this.cache.del(`billing:subscription:${organizationId}`);
  }
}
