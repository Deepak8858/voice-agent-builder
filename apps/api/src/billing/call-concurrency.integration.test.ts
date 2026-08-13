import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { CallConcurrencyService } from './call-concurrency.service';

// `vitest.setup.ts` always defines REDIS_URL so the env schema parses, which
// means its presence says nothing about a reachable server. This suite talks to
// a real Redis and is therefore opt-in: set BILLING_REDIS_INTEGRATION=1 (and a
// reachable REDIS_URL) to run it.
const redisUrl = process.env.BILLING_REDIS_INTEGRATION === '1' ? process.env.REDIS_URL : undefined;
const describeWithRedis = redisUrl ? describe : describe.skip;

describeWithRedis('CallConcurrencyService real Redis capacity', () => {
  const redis = redisUrl ? new IORedis(redisUrl, { maxRetriesPerRequest: 1 }) : null;
  const prisma = {
    callConcurrencyLease: {
      upsert: async () => ({}),
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [],
    },
  };
  const service = new CallConcurrencyService(
    prisma as never,
    { getConnection: () => redis } as never,
  );
  const orgIds = ['capacity-org-1', 'capacity-org-2', 'capacity-org-3'];

  beforeAll(async () => {
    Object.assign(env, { BILLING_GLOBAL_CONCURRENCY: 100, BILLING_LEASE_TTL_SECONDS: 90 });
    await redis?.del(
      'vf:v1:billing:concurrency:global',
      ...orgIds.map((id) => `vf:v1:billing:concurrency:org:${id}`),
    );
  });

  afterAll(async () => {
    await redis?.del(
      'vf:v1:billing:concurrency:global',
      ...orgIds.map((id) => `vf:v1:billing:concurrency:org:${id}`),
    );
    await redis?.quit();
  });

  it('admits exactly 100 of 101 parallel requests and returns to zero after release', async () => {
    const decisions = await Promise.all(Array.from({ length: 101 }, (_, index) => service.acquire({
      callId: `capacity-call-${index}`,
      organizationId: orgIds[Math.floor(index / 40)]!,
      organizationLimit: 50,
    })));
    const allowed = decisions.flatMap((decision, index) => decision.allowed
      ? [{ index, leaseToken: decision.leaseToken }]
      : []);
    const denied = decisions.filter((decision) => !decision.allowed);
    expect(allowed).toHaveLength(100);
    expect(denied).toEqual([{ allowed: false, reason: 'platform_concurrency_reached' }]);

    await Promise.all(allowed.map(({ index, leaseToken }) => service.release({
      callId: `capacity-call-${index}`,
      organizationId: orgIds[Math.floor(index / 40)]!,
      leaseToken,
    })));
    expect(await redis?.zcard('vf:v1:billing:concurrency:global')).toBe(0);
    await Promise.all(orgIds.map(async (id) => {
      expect(await redis?.zcard(`vf:v1:billing:concurrency:org:${id}`)).toBe(0);
    }));
  });
});
