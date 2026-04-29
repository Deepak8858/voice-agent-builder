import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';

/**
 * Generic Valkey/Redis-backed cache. Reuses the shared ioredis connection
 * created by QueueService so there's exactly one TCP connection per API
 * instance. Safe to call even when Valkey is not configured \u2014 writes become
 * no-ops and reads return null so callers do not have to branch.
 *
 * Suggested key scheme:
 *   vf:v1:<namespace>:<workspace_id?>:<id>
 * e.g. `vf:v1:templates:list`, `vf:v1:session:user:<uuid>`.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly prefix = 'vf:v1:';

  constructor(private readonly queue: QueueService) {}

  enabled(): boolean {
    return this.queue.enabled();
  }

  private k(key: string): string {
    return key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const conn = this.queue.getConnection();
    if (!conn) return null;
    try {
      const raw = await conn.get(this.k(key));
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      this.logger.debug(`[cache.get:${key}] ${(err as Error).message}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const conn = this.queue.getConnection();
    if (!conn) return;
    const payload = JSON.stringify(value);
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await conn.set(this.k(key), payload, 'EX', ttlSeconds);
      } else {
        await conn.set(this.k(key), payload);
      }
    } catch (err) {
      this.logger.debug(`[cache.set:${key}] ${(err as Error).message}`);
    }
  }

  async del(key: string): Promise<void> {
    const conn = this.queue.getConnection();
    if (!conn) return;
    try {
      await conn.del(this.k(key));
    } catch (err) {
      this.logger.debug(`[cache.del:${key}] ${(err as Error).message}`);
    }
  }

  /**
   * Read-through helper. Returns cached value if present; otherwise calls
   * `loader`, caches the result for `ttlSeconds`, and returns it.
   */
  async readThrough<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await loader();
    await this.set<T>(key, fresh, ttlSeconds);
    return fresh;
  }

  /**
   * Atomically increment a counter and optionally set its TTL.
   * Returns the new counter value. Useful for rate limiting.
   *
   * If Redis is disabled, returns 1 (allows first request through).
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const conn = this.queue.getConnection();
    if (!conn) return 1;
    try {
      const fullKey = this.k(key);
      const pipeline = conn.pipeline();
      pipeline.incr(fullKey);
      if (ttlSeconds && ttlSeconds > 0) {
        pipeline.expire(fullKey, ttlSeconds);
      }
      const results = await pipeline.exec();
      const count = results?.[0]?.[1] as number;
      return count ?? 1;
    } catch (err) {
      this.logger.debug(`[cache.incr:${key}] ${(err as Error).message}`);
      return 1;
    }
  }
}
