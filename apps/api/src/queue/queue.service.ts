import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { createConnection } from 'net';
import { env } from '../config/env';

const REDIS_DEFAULT_PORT = 6379;
const REDIS_HEALTH_TIMEOUT_MS = 300;

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
  private lastRedisErrorLogAt = 0;

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
        lazyConnect: true,
        enableOfflineQueue: false,
        // Valkey 8.x + ElastiCache Serverless are RESP-compatible. Keep-alive
        // helps keep the TLS connection warm across AWS NAT timeouts.
        enableReadyCheck: true,
        connectTimeout: 1_000,
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
        const now = Date.now();
        if (now - this.lastRedisErrorLogAt > 30_000) {
          this.lastRedisErrorLogAt = now;
          this.logger.warn(`[redis] ${err.message}`);
        }
      });
      this.connection.on('ready', () => {
        this.logger.log('[redis] connection ready');
      });
    }
    return this.connection;
  }

  getExistingConnection(): Redis | null {
    return this.connection;
  }

  getBullMqConnection(): ConnectionOptions {
    // Docker builds install dependencies without the lockfile, which can give BullMQ
    // its own ioredis type copy. The runtime client is still the same compatible API.
    return this.getConnection() as unknown as ConnectionOptions;
  }

  queue(name: string): Queue {
    const conn = this.getBullMqConnection();
    const existing = this.queues.get(name);
    if (existing) return existing;
    const q = new Queue(name, { connection: conn });
    this.queues.set(name, q);
    return q;
  }

  /**
   * `options` is per-call rather than a queue-wide default on purpose: BullMQ
   * treats a job with no `attempts` as single-shot, so a worker that throws to
   * request a retry is simply dropped. Only the callers whose jobs are safe to
   * re-run ask for retries; defaulting them here would silently re-run every
   * non-idempotent job in the system (usage, reconciliation, billing).
   */
  async enqueue<T extends object>(
    queueName: string,
    jobName: string,
    payload: T,
    options?: JobsOptions,
  ): Promise<void> {
    const q = this.queue(queueName);
    await q.add(jobName, payload, options);
  }

  /** Round-trip ping; useful for readiness probes. */
  async ping(): Promise<'ok' | 'error'> {
    try {
      await tcpConnect(env.REDIS_URL, REDIS_HEALTH_TIMEOUT_MS);
      return 'ok';
    } catch {
      return 'error';
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    if (this.connection) await this.connection.quit();
  }
}

function tcpConnect(redisUrl: string, timeoutMs: number): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    return Promise.reject(new Error('invalid redis url'));
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : REDIS_DEFAULT_PORT;
  if (!host || !Number.isInteger(port) || port <= 0) {
    return Promise.reject(new Error('invalid redis host or port'));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => finish(new Error('redis health timeout')), timeoutMs);
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
  });
}
