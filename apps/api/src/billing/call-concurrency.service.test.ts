import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { CallConcurrencyService } from './call-concurrency.service';

function makeService() {
  const redis = { eval: vi.fn(), multi: vi.fn() };
  const prisma = {
    callConcurrencyLease: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null as unknown),
      create: vi.fn(async () => ({})),
    },
  };
  const service = new CallConcurrencyService(
    prisma as never,
    { getConnection: () => redis } as never,
  );
  return { service, redis, prisma };
}

describe('CallConcurrencyService', () => {
  beforeEach(() => {
    Object.assign(env, { BILLING_GLOBAL_CONCURRENCY: 100, BILLING_LEASE_TTL_SECONDS: 90 });
  });

  it.each([
    ['platform', 'platform_concurrency_reached'],
    ['organization', 'organization_concurrency_reached'],
  ] as const)('maps the %s capacity denial', async (state, reason) => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue([state]);
    await expect(service.acquire({ callId: 'call-1', organizationId: 'org-1', organizationLimit: 2 }))
      .resolves.toEqual({ allowed: false, reason });
    expect(prisma.callConcurrencyLease.upsert).not.toHaveBeenCalled();
  });

  it('persists an allowed lease and returns the Redis expiry', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue(['allowed', 'call-1|token-1', '2000000000000']);
    await expect(service.acquire({ callId: 'call-1', organizationId: 'org-1', organizationLimit: 2 }))
      .resolves.toEqual({ allowed: true, leaseToken: 'token-1', expiresAt: new Date(2_000_000_000_000).toISOString() });
    expect(prisma.callConcurrencyLease.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { callId: 'call-1' },
      create: expect.objectContaining({ organizationId: 'org-1', leaseToken: 'token-1', state: 'active' }),
    }));
  });

  it('adopts the durable lease for a duplicate call id without issuing a new token', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue(['duplicate', 'call-1|original-token', '2000000000000']);
    prisma.callConcurrencyLease.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      leaseToken: 'original-token',
      state: 'active',
    });
    await expect(service.acquire({ callId: 'call-1', organizationId: 'org-1', organizationLimit: 2 }))
      .resolves.toEqual({
        allowed: true,
        leaseToken: 'original-token',
        expiresAt: new Date(2_000_000_000_000).toISOString(),
      });
    // The Redis slot is already held; re-persisting would overwrite the record.
    expect(prisma.callConcurrencyLease.upsert).not.toHaveBeenCalled();
    expect(prisma.callConcurrencyLease.create).not.toHaveBeenCalled();
  });

  it('recreates a missing durable record for a duplicate Redis member', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue(['duplicate', 'call-1|original-token', '2000000000000']);
    prisma.callConcurrencyLease.findUnique.mockResolvedValue(null);
    await expect(service.acquire({ callId: 'call-1', organizationId: 'org-1', organizationLimit: 2 }))
      .resolves.toMatchObject({ allowed: true, leaseToken: 'original-token' });
    expect(prisma.callConcurrencyLease.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        callId: 'call-1',
        organizationId: 'org-1',
        leaseToken: 'original-token',
        state: 'active',
      }),
    }));
  });

  it('fails closed when a duplicate lease belongs to another organization', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue(['duplicate', 'call-1|original-token', '2000000000000']);
    prisma.callConcurrencyLease.findUnique.mockResolvedValue({
      organizationId: 'org-other',
      leaseToken: 'original-token',
      state: 'active',
    });
    await expect(service.acquire({ callId: 'call-1', organizationId: 'org-1', organizationLimit: 2 }))
      .resolves.toEqual({ allowed: false, reason: 'billing_temporarily_unavailable' });
    // Only the acquire script ran: a live call's Redis member must not be freed.
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('replays active PostgreSQL leases into Redis on module init', async () => {
    const { service, redis, prisma } = makeService();
    const exec = vi.fn(async () => []);
    const zadd = vi.fn();
    redis.multi.mockReturnValue({ zadd, exec });
    prisma.callConcurrencyLease.findMany.mockResolvedValue([
      {
        callId: 'call-1',
        organizationId: 'org-1',
        leaseToken: 'token-1',
        expiresAt: new Date(2_000_000_000_000),
      },
    ] as never);

    await service.onModuleInit();

    expect(zadd).toHaveBeenCalledWith(expect.any(String), 2_000_000_000_000, 'call-1|token-1');
    expect(exec).toHaveBeenCalled();
  });

  it('releases Redis and fails closed when PostgreSQL persistence fails', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValueOnce(['allowed', 'call-1|token-1', '2000000000000']).mockResolvedValueOnce(2);
    prisma.callConcurrencyLease.upsert.mockRejectedValue(new Error('database unavailable'));
    await expect(service.acquire({ callId: 'call-1', organizationId: 'org-1', organizationLimit: 2 }))
      .resolves.toEqual({ allowed: false, reason: 'billing_temporarily_unavailable' });
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Redis is unavailable', async () => {
    const { service, redis } = makeService();
    redis.eval.mockRejectedValue(new Error('redis unavailable'));
    await expect(service.acquire({ callId: 'call-1', organizationId: 'org-1', organizationLimit: 2 }))
      .resolves.toEqual({ allowed: false, reason: 'billing_temporarily_unavailable' });
  });

  it('renews only when Redis and the token-matched recovery record agree', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue(1);
    prisma.callConcurrencyLease.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.renew({ callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1' }))
      .resolves.toBe(true);
    prisma.callConcurrencyLease.updateMany.mockResolvedValue({ count: 0 });
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(service.renew({ callId: 'call-1', organizationId: 'org-1', leaseToken: 'wrong' }))
      .resolves.toBe(false);
  });

  it('releases global and organization members then closes the recovery record', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue(2);
    await service.release({ callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1' });
    expect(prisma.callConcurrencyLease.updateMany).toHaveBeenCalledWith({
      where: { callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1', state: 'active' },
      data: { state: 'released', expiresAt: expect.any(Date) },
    });
  });
});
