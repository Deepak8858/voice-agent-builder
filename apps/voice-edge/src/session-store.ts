import { Redis } from 'ioredis';

let _redis: Redis | null = null;

function getRedis(url: string): Redis {
  if (!_redis) {
    _redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }
  return _redis;
}

export async function getSession(sessionId: string): Promise<string | null> {
  const redis = getRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  await redis.connect().catch(() => {}); // lazy connect
  return redis.get(`session:${sessionId}`);
}

export async function setSession(
  sessionId: string,
  data: string,
  ttlSeconds: number,
): Promise<void> {
  const redis = getRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  await redis.connect().catch(() => {});
  await redis.setex(`session:${sessionId}`, ttlSeconds, data);
}

export async function delSession(sessionId: string): Promise<void> {
  const redis = getRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  await redis.connect().catch(() => {});
  await redis.del(`session:${sessionId}`);
}
