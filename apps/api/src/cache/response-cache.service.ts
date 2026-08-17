import { Injectable } from '@nestjs/common';
import { CacheService } from './cache.service';
import {
  buildResponseCacheKey,
  responseCacheVersionKey,
  type ResponseCacheScope,
} from './response-cache.key';

/**
 * Short-TTL response cache for hot authenticated reads.
 *
 * Two properties matter here:
 *
 * 1. Every entry is keyed by workspace *and* user, so a cached response can
 *    never be served across a tenant or permission boundary. The key builder
 *    enforces this by throwing rather than defaulting.
 * 2. Invalidation is a version counter per workspace, not a key sweep. A
 *    mutation bumps `resp:v1:ver:ws:{id}`, which changes the computed key for
 *    every user and route in that workspace at once. The orphaned entries are
 *    never read again and expire on their own TTL, so we avoid `SCAN`/`KEYS`
 *    on the shared Redis instance.
 *
 * TTLs are deliberately short (10-60s). This is a stampede/burst absorber for
 * navigation-triggered reads, not a source of truth.
 */
@Injectable()
export class ResponseCacheService {
  constructor(private readonly cache: CacheService) {}

  /**
   * Read through the cache for a scoped route.
   * A cache miss, an unavailable Redis, or an invalid scope all fall back to
   * `loader()` — caching is never allowed to fail a request.
   */
  async readThrough<T>(
    scope: ResponseCacheScope,
    route: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    variant?: string,
  ): Promise<T> {
    const key = await this.resolveKey(scope, route, variant);
    if (key === null) return loader();
    return this.cache.readThrough(key, ttlSeconds, loader);
  }

  /**
   * Read through one pinned cache generation and report whether it was a hit.
   * Resolving the key once prevents a concurrent invalidation from publishing
   * data loaded under the old generation into the new generation.
   */
  async readThroughWithStatus<T>(
    scope: ResponseCacheScope,
    route: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    variant?: string,
  ): Promise<{ value: T; fromCache: boolean }> {
    const key = await this.resolveKey(scope, route, variant);
    if (key === null) return { value: await loader(), fromCache: false };

    const cached = await this.cache.get<T>(key);
    if (cached !== null) return { value: cached, fromCache: true };

    const value = await loader();
    await this.cache.set(key, value, ttlSeconds);
    return { value, fromCache: false };
  }

  /** Scoped read. Returns null on a miss, an invalid scope, or no Redis. */
  async get<T>(scope: ResponseCacheScope, route: string, variant?: string): Promise<T | null> {
    const key = await this.resolveKey(scope, route, variant);
    if (key === null) return null;
    return this.cache.get<T>(key);
  }

  /** Scoped write. Silently does nothing when the scope is unusable. */
  async set<T>(
    scope: ResponseCacheScope,
    route: string,
    value: T,
    ttlSeconds: number,
    variant?: string,
  ): Promise<void> {
    const key = await this.resolveKey(scope, route, variant);
    if (key === null) return;
    await this.cache.set<T>(key, value, ttlSeconds);
  }

  /**
   * Returns the fully qualified key, or null when the request must not be
   * cached (invalid scope). Never throws: a cache problem must not turn into
   * a request failure.
   */
  private async resolveKey(
    scope: ResponseCacheScope,
    route: string,
    variant?: string,
  ): Promise<string | null> {
    try {
      const version = await this.currentVersion(scope.workspaceId);
      return buildResponseCacheKey(scope, route, { variant, version });
    } catch {
      return null;
    }
  }

  /**
   * Invalidate every cached response for a workspace by moving it to a new
   * cache generation.
   */
  async invalidateWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.cache.incr(responseCacheVersionKey(workspaceId));
    } catch {
      // A failed bump only means callers keep serving entries until their
      // short TTL expires; it must not break the mutation that triggered it.
    }
  }

  private async currentVersion(workspaceId: string): Promise<number> {
    const stored = await this.cache.get<number>(responseCacheVersionKey(workspaceId));
    return typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  }
}
