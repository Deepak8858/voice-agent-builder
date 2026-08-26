import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconciliationService } from './reconciliation.service';

const ORG = 'org-1';

interface BalanceRow {
  organizationId: string;
  availableSeconds: number;
  reservedSeconds: number;
}

interface BucketRow {
  id: string;
  organizationId: string;
  remainingSeconds: number;
  sourceType: string;
  expiresAt: Date;
}

interface CallUsageRow {
  id: string;
  organizationId: string;
  callId: string;
  reservedSeconds: number;
  debitedSeconds: number;
  createdAt: Date;
  finalizationState?: 'pending' | 'releasing';
}

interface LeaseRow {
  id: string;
  organizationId: string;
  callId: string;
  expiresAt: Date;
}

function makeService(
  opts: {
    balances?: BalanceRow[];
    activeBuckets?: Array<{ remainingSeconds: number }>;
    expiringBuckets?: BucketRow[];
    staleCalls?: CallUsageRow[];
    leases?: LeaseRow[];
    lockAvailable?: boolean;
    subscriptions?: Array<{ organizationId: string }>;
    costSum?: number;
    outstandingReservations?: {
      matureReservedSeconds: number;
      freshReservationCount: number;
    };
  } = {},
) {
  const balances = opts.balances ?? [];

  const balanceUpdate = vi.fn(async (_args: unknown) => ({}));
  const balanceUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const bucketUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const callUsageUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const leaseUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

  const tx = {
    billingCreditBucket: {
      findMany: vi.fn(async () => opts.activeBuckets ?? []),
    },
    organizationCreditBalance: {
      findUnique: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
        return balances.find((b) => b.organizationId === where.organizationId) ?? null;
      }),
      update: balanceUpdate,
    },
    // Dispatches on the query text because reconciliation now issues three
    // distinct raw queries inside one transaction: the advisory lock, the
    // balance row lock, and the outstanding-reservation aggregate.
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      const text = Array.from(args[0] as ArrayLike<string>).join(' ');
      if (text.includes('pg_try_advisory_xact_lock')) {
        return [{ locked: opts.lockAvailable ?? true }];
      }
      if (text.includes('FOR UPDATE')) {
        return [{ id: 'balance-row-1' }];
      }
      return [
        opts.outstandingReservations ?? {
          matureReservedSeconds: 0,
          freshReservationCount: 0,
        },
      ];
    }),
  };

  const prisma = {
    organizationCreditBalance: {
      findMany: vi.fn(async () => balances),
      findUnique: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
        return balances.find((b) => b.organizationId === where.organizationId) ?? null;
      }),
      update: balanceUpdate,
      updateMany: balanceUpdateMany,
      aggregate: vi.fn(async () => ({
        _sum: {
          availableSeconds: balances.reduce((t, b) => t + b.availableSeconds, 0),
          reservedSeconds: balances.reduce((t, b) => t + b.reservedSeconds, 0),
        },
      })),
    },
    billingCreditBucket: {
      findMany: vi.fn(async () => opts.expiringBuckets ?? []),
      updateMany: bucketUpdateMany,
    },
    callUsage: {
      findMany: vi.fn(async () => opts.staleCalls ?? []),
      updateMany: callUsageUpdateMany,
    },
    callConcurrencyLease: {
      findMany: vi.fn(async () => opts.leases ?? []),
      updateMany: leaseUpdateMany,
      count: vi.fn(async () => 3),
    },
    subscription: {
      findMany: vi.fn(
        async (_args: { where: { plan: string } }) => opts.subscriptions ?? [],
      ),
    },
    providerCostEvent: {
      aggregate: vi.fn(async () => ({ _sum: { amount: opts.costSum ?? 0 } })),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const audit = { log: vi.fn(async () => undefined) };
  const metrics = {
    billingAvailableSeconds: { set: vi.fn() },
    billingReservedSeconds: { set: vi.fn() },
    callsActiveGlobal: { set: vi.fn() },
    planContributionMarginRatio: { labels: vi.fn(() => ({ set: vi.fn() })) },
    billingReconciliationCorrectionsTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
  };
  const providerCosts = {
    estimateMissingCallCosts: vi.fn(async () => 0),
    costCoverage: vi.fn(async () => ({
      finalizedCalls: 0,
      callsMissingCost: 0,
      missingRatio: 0,
    })),
  };
  const creditLedger = {
    releaseReservation: vi.fn(async () => undefined),
  };

  return {
    prisma,
    tx,
    audit,
    metrics,
    providerCosts,
    creditLedger,
    balanceUpdate,
    balanceUpdateMany,
    bucketUpdateMany,
    callUsageUpdateMany,
    leaseUpdateMany,
    service: new ReconciliationService(
      prisma as never,
      audit as never,
      metrics as never,
      providerCosts as never,
      creditLedger as never,
    ),
  };
}

describe('ReconciliationService.reconcileBalances', () => {
  beforeEach(() => vi.clearAllMocks());

  it('repairs a drifted projection and audits the correction', async () => {
    const { service, balanceUpdate, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 100, reservedSeconds: 60 }],
      // Reservations already reduced bucket remaining seconds; the projection
      // must match the bucket sum without subtracting reserved seconds again.
      activeBuckets: [{ remainingSeconds: 600 }],
    });

    const report = await service.reconcileBalances();

    expect(report.projectionCorrections).toBe(1);
    expect(balanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ availableSeconds: 600 }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        action: 'billing.projection_corrected',
        metadata: expect.objectContaining({
          previousAvailableSeconds: 100,
          correctedAvailableSeconds: 600,
          driftSeconds: 500,
        }),
      }),
    );
  });

  it('leaves a consistent projection untouched', async () => {
    const { service, balanceUpdate, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 600, reservedSeconds: 60 }],
      activeBuckets: [{ remainingSeconds: 600 }],
      // The reserved projection matches the ledger's mature outstanding sum.
      outstandingReservations: { matureReservedSeconds: 60, freshReservationCount: 0 },
    });

    const report = await service.reconcileBalances();

    expect(report.projectionCorrections).toBe(0);
    expect(balanceUpdate).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('repairs stranded reservedSeconds from the ledger outstanding sum', async () => {
    // The projection says a minute is still reserved, but every ledger
    // reservation has been committed or released: the stranded 60s would
    // shrink the customer's usable balance forever.
    const { service, balanceUpdate, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 600, reservedSeconds: 60 }],
      activeBuckets: [{ remainingSeconds: 600 }],
      outstandingReservations: { matureReservedSeconds: 0, freshReservationCount: 0 },
    });

    const report = await service.reconcileBalances();

    expect(report.projectionCorrections).toBe(1);
    expect(balanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reservedSeconds: 0 }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.projection_corrected',
        metadata: expect.objectContaining({
          previousReservedSeconds: 60,
          correctedReservedSeconds: 0,
          reservedDriftSeconds: -60,
          reservedRepairDeferred: false,
        }),
      }),
    );
  });

  it('restores reservedSeconds lost by the projection', async () => {
    // The mirror image: the ledger holds a mature outstanding reservation the
    // projection dropped. Without repair the org can over-admit calls.
    const { service, balanceUpdate } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 600, reservedSeconds: 0 }],
      activeBuckets: [{ remainingSeconds: 600 }],
      outstandingReservations: { matureReservedSeconds: 60, freshReservationCount: 0 },
    });

    const report = await service.reconcileBalances();

    expect(report.projectionCorrections).toBe(1);
    expect(balanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reservedSeconds: 60 }),
      }),
    );
  });

  it('defers the reserved repair while a fresh reservation is in flight', async () => {
    // A reservation younger than the stale-call timeout may be mid-commit;
    // clawing it back here would race the ledger. The repair must wait for a
    // later pass instead of touching reservedSeconds.
    const { service, balanceUpdate, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 600, reservedSeconds: 60 }],
      activeBuckets: [{ remainingSeconds: 600 }],
      outstandingReservations: { matureReservedSeconds: 0, freshReservationCount: 1 },
    });

    const report = await service.reconcileBalances();

    expect(report.projectionCorrections).toBe(0);
    expect(balanceUpdate).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('still repairs available drift while the reserved repair is deferred', async () => {
    const { service, balanceUpdate, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 100, reservedSeconds: 60 }],
      activeBuckets: [{ remainingSeconds: 600 }],
      outstandingReservations: { matureReservedSeconds: 0, freshReservationCount: 1 },
    });

    const report = await service.reconcileBalances();

    expect(report.projectionCorrections).toBe(1);
    expect(balanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ availableSeconds: 600 }),
      }),
    );
    // reservedSeconds must be absent from the write while deferred.
    const [updateArgs] = balanceUpdate.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(updateArgs.data).not.toHaveProperty('reservedSeconds');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reservedRepairDeferred: true }),
      }),
    );
  });

  it('locks the balance row before reading the projection', async () => {
    const { service, tx } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 0, reservedSeconds: 0 }],
      activeBuckets: [],
    });

    await service.reconcileBalances();

    // The advisory lock only excludes other reconciliation replicas; the row
    // lock is what serializes against ledger commits and releases.
    const rowLockCall = tx.$queryRaw.mock.calls.find(([templateStrings]) =>
      Array.from(templateStrings as ArrayLike<string>)
        .join(' ')
        .includes('FOR UPDATE'),
    );
    expect(rowLockCall).toBeDefined();
  });

  it('takes a transaction-scoped advisory lock per organization', async () => {
    const { service, tx } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 0, reservedSeconds: 0 }],
      activeBuckets: [],
    });

    await service.reconcileBalances();

    // Transaction-scoped, so a crashed worker cannot wedge the organization.
    const [templateStrings] = tx.$queryRaw.mock.calls[0] ?? [];
    expect(Array.from(templateStrings as ArrayLike<string>).join('')).toContain(
      'pg_try_advisory_xact_lock',
    );
  });

  it('continues to the next organization when one repair fails', async () => {
    const { service, audit } = makeService({
      balances: [
        { organizationId: 'org-a', availableSeconds: 0, reservedSeconds: 0 },
        { organizationId: 'org-b', availableSeconds: 0, reservedSeconds: 0 },
      ],
      activeBuckets: [{ remainingSeconds: 60 }],
      lockAvailable: false,
    });

    const report = await service.reconcileBalances();

    expect(report.organizationsChecked).toBe(2);
    expect(report.projectionCorrections).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('publishes balance gauges', async () => {
    const { service, metrics } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 540, reservedSeconds: 60 }],
      activeBuckets: [{ remainingSeconds: 600 }],
    });

    await service.reconcileBalances();

    expect(metrics.billingAvailableSeconds.set).toHaveBeenCalledWith(540);
    expect(metrics.billingReservedSeconds.set).toHaveBeenCalledWith(60);
  });
});

describe('ReconciliationService.expireBuckets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('expires a bucket and audits the forfeited seconds once', async () => {
    const { service, bucketUpdateMany, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 300, reservedSeconds: 0 }],
      activeBuckets: [],
      expiringBuckets: [
        {
          id: 'bucket-1',
          organizationId: ORG,
          remainingSeconds: 300,
          sourceType: 'purchased',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });

    const report = await service.expireBuckets();

    expect(report.expiredBuckets).toBe(1);
    // Guarded on status so a concurrent replica cannot double-decrement.
    expect(bucketUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bucket-1', status: 'active' },
        data: { remainingSeconds: 0, status: 'expired' },
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.bucket_expired',
        metadata: expect.objectContaining({ forfeitedSeconds: 300 }),
      }),
    );
  });

  it('does not audit when another replica already expired the bucket', async () => {
    const { service, bucketUpdateMany, audit } = makeService({
      expiringBuckets: [
        {
          id: 'bucket-1',
          organizationId: ORG,
          remainingSeconds: 300,
          sourceType: 'purchased',
          expiresAt: new Date(),
        },
      ],
    });
    bucketUpdateMany.mockResolvedValueOnce({ count: 0 });

    const report = await service.expireBuckets();

    expect(report.expiredBuckets).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('ReconciliationService.finalizeStaleCalls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('finalizes an unconnected call and releases its reservation', async () => {
    const { service, callUsageUpdateMany, creditLedger, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 0, reservedSeconds: 60 }],
      staleCalls: [
        {
          id: 'usage-1',
          organizationId: ORG,
          callId: 'call-1',
          reservedSeconds: 60,
          debitedSeconds: 0,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });

    const report = await service.finalizeStaleCalls();

    expect(report.staleCallsFinalized).toBe(1);
    expect(callUsageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          finalizationState: 'finalized',
          disposition: 'not_connected',
        }),
      }),
    );
    expect(creditLedger.releaseReservation).toHaveBeenCalledWith({
      organizationId: ORG,
      callId: 'call-1',
      idempotencyKey: 'reconciliation:stale:call-1:release',
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.stale_call_finalized' }),
    );
  });

  it('flags an ambiguous call for review instead of guessing its duration', async () => {
    const { service, callUsageUpdateMany, balanceUpdateMany, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 0, reservedSeconds: 60 }],
      staleCalls: [
        {
          id: 'usage-1',
          organizationId: ORG,
          callId: 'call-1',
          reservedSeconds: 60,
          // Debits mean the call did connect; finalizing it as not-connected
          // would silently refund real usage.
          debitedSeconds: 120,
          createdAt: new Date(),
        },
      ],
    });

    const report = await service.finalizeStaleCalls();

    expect(report.manualReviewsCreated).toBe(1);
    expect(report.staleCallsFinalized).toBe(0);
    expect(callUsageUpdateMany).not.toHaveBeenCalled();
    expect(balanceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'review', reviewReason: 'stale_call_with_debits' },
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.manual_review_created' }),
    );
  });

  it('keeps a failed release retryable and continues the batch', async () => {
    const { service, creditLedger, callUsageUpdateMany, audit } = makeService({
      staleCalls: [
        {
          id: 'usage-1',
          organizationId: ORG,
          callId: 'call-1',
          reservedSeconds: 60,
          debitedSeconds: 0,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'usage-2',
          organizationId: ORG,
          callId: 'call-2',
          reservedSeconds: 60,
          debitedSeconds: 0,
          createdAt: new Date('2026-01-01T00:01:00.000Z'),
        },
      ],
    });
    creditLedger.releaseReservation
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);

    const report = await service.finalizeStaleCalls();

    expect(report.staleCallsFinalized).toBe(1);
    expect(creditLedger.releaseReservation).toHaveBeenCalledTimes(2);
    expect(callUsageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { finalizationState: 'releasing' } }),
    );
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('retries a previously claimed stale release', async () => {
    const { service, prisma, creditLedger, callUsageUpdateMany } = makeService({
      staleCalls: [
        {
          id: 'usage-1',
          organizationId: ORG,
          callId: 'call-1',
          reservedSeconds: 60,
          debitedSeconds: 0,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          // A previous pass claimed this row and then died before the ledger
          // released the reservation, so it is already `releasing`.
          finalizationState: 'releasing',
        },
      ],
    });

    const report = await service.finalizeStaleCalls();

    expect(prisma.callUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ finalizationState: { in: ['pending', 'releasing'] } }),
      }),
    );
    // The claim has to match a row that is already `releasing`, otherwise a
    // half-finished release is stranded and its reservation never returns.
    expect(callUsageUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'usage-1',
          finalizationState: { in: ['pending', 'releasing'] },
        }),
        data: { finalizationState: 'releasing' },
      }),
    );
    expect(creditLedger.releaseReservation).toHaveBeenCalledOnce();
    expect(callUsageUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: 'usage-1', finalizationState: 'releasing' }),
        data: expect.objectContaining({ finalizationState: 'finalized' }),
      }),
    );
    expect(report.staleCallsFinalized).toBe(1);
  });

  it('delegates release invariants to the transactional credit ledger', async () => {
    const { service, creditLedger } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 0, reservedSeconds: 30 }],
      staleCalls: [
        {
          id: 'usage-1',
          organizationId: ORG,
          callId: 'call-1',
          reservedSeconds: 60,
          debitedSeconds: 0,
          createdAt: new Date(),
        },
      ],
    });

    await service.finalizeStaleCalls();

    expect(creditLedger.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, callId: 'call-1' }),
    );
  });
});

describe('ReconciliationService.recoverLeases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('releases an expired lease and audits it', async () => {
    const { service, leaseUpdateMany, audit } = makeService({
      leases: [
        {
          id: 'lease-1',
          organizationId: ORG,
          callId: 'call-1',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });

    const report = await service.recoverLeases();

    expect(report.leasesRecovered).toBe(1);
    expect(leaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lease-1', state: 'active' },
        data: { state: 'released' },
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.lease_recovered' }),
    );
  });

  it('publishes the global concurrency gauge', async () => {
    const { service, metrics } = makeService({ leases: [] });

    await service.recoverLeases();

    expect(metrics.callsActiveGlobal.set).toHaveBeenCalledWith(3);
  });
});

describe('ReconciliationService.reconcileProviderCosts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports estimates created for calls missing cost events', async () => {
    const { service, providerCosts } = makeService();
    providerCosts.estimateMissingCallCosts.mockResolvedValueOnce(7);

    const report = await service.reconcileProviderCosts();

    expect(report.costEventsEstimated).toBe(7);
  });

  it('alerts when more than one percent of calls have no provider cost', async () => {
    const { service, providerCosts } = makeService();
    providerCosts.costCoverage.mockResolvedValueOnce({
      finalizedCalls: 1_000,
      callsMissingCost: 25,
      missingRatio: 0.025,
    });
    const logger = vi
      .spyOn(
        Object.getPrototypeOf(
          (service as unknown as { logger: { error: (m: string) => void } }).logger,
        ),
        'error',
      )
      .mockImplementation(() => undefined);

    await service.reconcileProviderCosts();

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Provider cost coverage gap'));
    logger.mockRestore();
  });
});

describe('ReconciliationService.publishMarginMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips plans with no active subscriptions rather than reporting zero', async () => {
    const { service, metrics } = makeService({ subscriptions: [] });

    await service.publishMarginMetrics();

    // Zero margin and no customers are different situations; conflating them
    // would page on an empty plan.
    expect(metrics.planContributionMarginRatio.labels).not.toHaveBeenCalled();
  });

  it('reports margin as revenue minus provider cost over revenue', async () => {
    const set = vi.fn();
    const { service, metrics, prisma } = makeService({ costSum: 99 });
    metrics.planContributionMarginRatio.labels.mockReturnValue({ set });
    // One Starter subscription at $99/month against $99 of provider cost.
    prisma.subscription.findMany.mockImplementation(async ({ where }) =>
      where.plan === 'starter' ? [{ organizationId: ORG }] : [],
    );

    await service.publishMarginMetrics();

    expect(metrics.planContributionMarginRatio.labels).toHaveBeenCalledWith('starter');
    expect(set).toHaveBeenCalledWith(0);
  });
});
