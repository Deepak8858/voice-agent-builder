import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';

/**
 * Centralized cache invalidation service. Provides semantic methods for
 * invalidating cache entries rather than scattered inline cache.del() calls.
 */
@Injectable()
export class CacheInvalidator {
  constructor(private readonly cache: CacheService) {}

  invalidateAgentList(workspaceId: string) {
    return this.cache.del(`agents:list:${workspaceId}`);
  }

  invalidateWorkspaceList(userId: string) {
    return this.cache.del(`workspaces:user:${userId}`);
  }

  async invalidateSession(userId: string, workspaceId?: string) {
    await this.cache.del(`session:user:${userId}`);
    if (workspaceId) {
      await this.cache.del(`session:workspace:${workspaceId}`);
    }
  }
}