import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';

/**
 * Lightweight queue facade + shared Valkey/Redis connection factory.
 *
 * Works against:
 *   - Local Redis / Valkey:       redis://localhost:6379
 *   - AWS ElastiCache Serverless: rediss://:<password>@<name>.serverless.<region>.cache.amazonaws.com:6379
 *   - Upstash / Redis Cloud:      rediss://default:<password>@<host>:<port>
 *
 * `REDIS_URL` is required (validated by `env`).
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private connection: Redis | null = null;

  /**
   * Shared ioredis connection. Used by QueueService itself for BullMQ and
   * by CacheService for key/value reads and writes. Created lazily on the
   * first caller.
   */
  getConnection(): Redis {
    if (!this.connection) {
      const url = env.REDIS_URL;
      const options: RedisOptions = {
        // Required by BullMQ workers.
        maxRetriesPerRequest: null,
        // Valkey 8.x + ElastiCache Serverless are RESP-compatible. Keep-alive
        // helps keep the TLS connection warm across AWS NAT timeouts.
        enableReadyCheck: true,
        keepAlive: 30_000,
        retryStrategy: (times) => Math.min(times * 200, 2_000),
        reconnectOnError: (err) => {
          const msg = err.message || '';
          // Reconnect on typical transient AWS failures.
          return /READONLY|ECONNRESET|ETIMEDOUT/.test(msg);
        },
      };

      // TLS is mandatory for ElastiCache Serverless; signalled via rediss://.
      // Parse here so we can set SNI/serverName for clusters that need it.
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'rediss:') {
          options.tls = { servername: parsed.hostname };
        }
      } catch {
        // ioredis will still accept a bare `host:port` string.
      }

      this.connection = new IORedis(url, options);
      this.connection.on('error', (err) => {
        this.logger.error(`[redis] ${err.message}`);
      });
      this.connection.on('ready', () => {
        this.logger.log('[redis] connection ready');
      });
    }
    return this.connection;
  }

  queue(name: string): Queue {
    const conn = this.getConnection();
    const existing = this.queues.get(name);
    if (existing) return existing;
    const q = new Queue(name, { connection: conn });
    this.queues.set(name, q);
    return q;
  }

  async enqueue<T extends object>(queueName: string, jobName: string, payload: T): Promise<void> {
    const q = this.queue(queueName);
    await q.add(jobName, payload);
  }

  /** Round-trip ping; useful for readiness probes. */
  async ping(): Promise<'ok' | 'error'> {
    try {
      const reply = await this.getConnection().ping();
      return reply === 'PONG' ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    if (this.connection) await this.connection.quit();
  }
}
