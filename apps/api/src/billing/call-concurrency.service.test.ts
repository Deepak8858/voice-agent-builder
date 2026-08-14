import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { CallConcurrencyService } from './call-concurrency.service';

function makeService() {
  const redis = { eval: vi.fn(), multi: vi.fn() };
  const prisma = {
    callConcurrencyLease: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async (_args?: unknown) => [] as unknown[]),
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

  it('closes the durable lease even when Redis release fails', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.release({ callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1' }),
    ).resolves.toBeUndefined();

    expect(prisma.callConcurrencyLease.updateMany).toHaveBeenCalledOnce();
  });

  it('does not throw when durable lease cleanup fails', async () => {
    const { service, redis, prisma } = makeService();
    redis.eval.mockResolvedValue(2);
    prisma.callConcurrencyLease.updateMany.mockRejectedValue(new Error('database unavailable'));

    await expect(
      service.release({ callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1' }),
    ).resolves.toBeUndefined();
  });

  /**
   * Without renewal, any call longer than the lease TTL loses its concurrency
   * slot mid-conversation and the organization can exceed the concurrency its
   * plan sells.
   */
  describe('renewActiveLeases', () => {
    it('only considers unexpired leases of calls that are still in flight', async () => {
      const { service, prisma } = makeService();
      prisma.callConcurrencyLease.findMany.mockResolvedValue([]);

      await service.renewActiveLeases(50);

      const query = prisma.callConcurrencyLease.findMany.mock.calls[0]![0] as {
        where: {
          state: string;
          expiresAt: { gt: Date; lte: Date };
          call: { status: { in: string[] } };
        };
        take: number;
      };
      expect(query.where.state).toBe('active');
      expect(query.where.call.status.in).toEqual(['queued', 'ringing', 'in_progress']);
      expect(query.where.expiresAt.lte.getTime()).toBeGreaterThan(query.where.expiresAt.gt.getTime());
      expect(query.take).toBe(50);
    });

    it('extends the expiry of every in-flight lease it finds', async () => {
      const { service, redis, prisma } = makeService();
      prisma.callConcurrencyLease.findMany.mockResolvedValue([
        { callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1' },
        { callId: 'call-2', organizationId: 'org-1', leaseToken: 'token-2' },
      ] as never);
      redis.eval.mockResolvedValue(1);
      prisma.callConcurrencyLease.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.renewActiveLeases(50)).resolves.toEqual({
        checked: 2,
        renewed: 2,
        dropped: 0,
      });
    });

    it('is idempotent: a second sweep over the same leases renews them again without side effects', async () => {
      const { service, redis, prisma } = makeService();
      prisma.callConcurrencyLease.findMany.mockResolvedValue([
        { callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1' },
      ] as never);
      redis.eval.mockResolvedValue(1);
      prisma.callConcurrencyLease.updateMany.mockResolvedValue({ count: 1 });

      const first = await service.renewActiveLeases(50);
      const second = await service.renewActiveLeases(50);

      expect(second).toEqual(first);
    });

    it('reports a lease it cannot renew instead of pretending the slot is held', async () => {
      const { service, redis, prisma } = makeService();
      prisma.callConcurrencyLease.findMany.mockResolvedValue([
        { callId: 'call-1', organizationId: 'org-1', leaseToken: 'stale-token' },
      ] as never);
      // Redis renews, but the durable row does not match the token.
      redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      prisma.callConcurrencyLease.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.renewActiveLeases(50)).resolves.toEqual({
        checked: 1,
        renewed: 0,
        dropped: 1,
      });
    });

    it('fails closed when Redis is unavailable', async () => {
      const { service, redis, prisma } = makeService();
      prisma.callConcurrencyLease.findMany.mockResolvedValue([
        { callId: 'call-1', organizationId: 'org-1', leaseToken: 'token-1' },
      ] as never);
      redis.eval.mockRejectedValue(new Error('redis unavailable'));

      await expect(service.renewActiveLeases(50)).resolves.toMatchObject({ renewed: 0, dropped: 1 });
    });
  });
});
