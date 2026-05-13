import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';

/**
 * Generic Valkey/Redis-backed cache. Reuses the shared ioredis connection
 * created by QueueService so there's exactly one TCP connection per API
 * instance.
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

  private k(key: string): string {
    return key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.queue.getConnection().get(this.k(key));
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      this.logger.debug(`[cache.get:${key}] ${(err as Error).message}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    try {
      const conn = this.queue.getConnection();
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
    try {
      await this.queue.getConnection().del(this.k(key));
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
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    try {
      const conn = this.queue.getConnection();
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

  /**
   * Publish a message to a Redis Pub/Sub channel.
   * Used for real-time SSE — subscribers to `call:{callId}` receive live events.
   */
  async publish(channel: string, message: unknown): Promise<void> {
    try {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      await this.queue.getConnection().publish(channel, payload);
    } catch (err) {
      this.logger.debug(`[cache.publish:${channel}] ${(err as Error).message}`);
    }
  }

  /**
   * Subscribe to a Redis Pub/Sub channel and yield messages as they arrive.
   * Returns a ReadableStream of parsed JSON messages. Caller is responsible for cleanup.
   *
   * Usage:
   *   const stream = cache.subscribe('call:abc');
   *   const reader = stream.getReader();
   *   while (true) { const { value } = await reader.read(); ... }
   */
  subscribe(channel: string): ReadableStream<string> {
    const queue = this.queue;
    let cleanup: (() => void) | null = null;

    return new ReadableStream<string>({
      start(controller) {
        const conn = queue.getConnection().duplicate() as import('ioredis').Redis;
        conn.connect().catch(() => {});
        const msgQueue: string[] = [];
        let flushing = false;

        const flush = () => {
          if (flushing || msgQueue.length === 0) return;
          flushing = true;
          while (msgQueue.length > 0) {
            try {
              controller.enqueue(msgQueue.shift()!);
            } catch {
              flushing = false;
              return;
            }
          }
          flushing = false;
        };

        const handler = (_ch: string, msg: string) => {
          msgQueue.push(msg);
          flush();
        };

        conn.on('message', handler);
        conn.subscribe(channel).catch(() => {});

        cleanup = () => {
          conn.off('message', handler);
          conn.unsubscribe(channel).catch(() => {});
          conn.disconnect();
        };
      },
      cancel() {
        cleanup?.();
      },
    });
  }
}
