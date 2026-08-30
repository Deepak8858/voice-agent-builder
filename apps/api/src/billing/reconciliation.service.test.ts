import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyReconciliationReport, ReconciliationService } from './reconciliation.service';

const ORG = 'org-1';
const CUSTOMER = 'cus_1';

interface BalanceRow {
  organizationId: string;
  availableSeconds: number;
  reservedSeconds: number;
  /** Only the clearing tests care; the rest of the suite leaves these unset. */
  status?: string;
  reviewReason?: string | null;
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
  finalizationState?: 'pending' | 'releasing' | 'connected';
  /** Only the abandoned-after-connect arm reads these two. */
  connectedAt?: Date | null;
  billableSeconds?: number;
}

interface LeaseRow {
  id: string;
  organizationId: string;
  callId: string;
  expiresAt: Date;
}

/** A `billing_credit_buckets` row as the Stripe drift comparison reads it. */
interface GrantRow {
  organizationId: string;
  sourceType: 'included' | 'purchased';
  sourceId: string;
}

interface SubscriptionRow {
  organizationId: string;
  stripeSubscriptionId: string | null;
  status: string;
  stripePriceId: string | null;
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
    // Stripe drift comparison fixtures.
    stripeInvoices?: Array<{
      id: string;
      customer: unknown;
      parent: { type: string; subscription_details?: { subscription?: unknown } | null } | null;
      amount_paid: number;
    }>;
    stripeSessions?: Array<{
      id: string;
      customer: unknown;
      payment_status: string | null;
      metadata: Record<string, string> | null;
    }>;
    stripeSubscriptions?: Array<{
      id: string;
      status: string;
      items?: { data?: Array<{ price?: { id?: string | null } | null }> };
    }>;
    stripeSubscriptionsHasMore?: boolean;
    /** Buckets the bulk pre-filter finds for the listed Stripe objects. */
    grantedBuckets?: GrantRow[];
    /** Buckets the locked re-check finds; defaults to `grantedBuckets`. */
    confirmedBuckets?: GrantRow[];
    /** Which organization owns each Stripe customer. */
    subscriptionOwners?: Array<{ organizationId: string; stripeCustomerId: string | null }>;
    /** Our rows for the subscriptions Stripe listed. */
    linkedSubscriptions?: SubscriptionRow[];
    /** Our rows that claim a live subscription, for the reverse check. */
    locallyLiveSubscriptions?: SubscriptionRow[];
  } = {},
) {
  const balances = opts.balances ?? [];
  const confirmedBuckets = opts.confirmedBuckets ?? opts.grantedBuckets ?? [];
  const subscriptionRows = [
    ...(opts.linkedSubscriptions ?? []),
    ...(opts.locallyLiveSubscriptions ?? []),
  ];

  const balanceUpdate = vi.fn(async (_args: unknown) => ({}));
  const balanceUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const bucketUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const callUsageUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const leaseUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

  const tx = {
    billingCreditBucket: {
      findMany: vi.fn(async () => opts.activeBuckets ?? []),
      // The locked re-check of one Stripe object against one bucket.
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId_sourceType_sourceId: GrantRow };
        }) => {
          const key = where.organizationId_sourceType_sourceId;
          return (
            confirmedBuckets.find(
              (bucket) =>
                bucket.organizationId === key.organizationId &&
                bucket.sourceType === key.sourceType &&
                bucket.sourceId === key.sourceId,
            ) ?? null
          );
        },
      ),
    },
    subscription: {
      findUnique: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
        return subscriptionRows.find((row) => row.organizationId === where.organizationId) ?? null;
      }),
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
      // Two callers: bucket expiry (by status) and the Stripe drift bulk
      // pre-filter (by the Stripe IDs it just listed).
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        args?.where && 'sourceId' in args.where
          ? (opts.grantedBuckets ?? [])
          : (opts.expiringBuckets ?? []),
      ),
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
      // One table, four callers: margin metrics (by plan), Stripe customer
      // ownership, our rows for the subscriptions Stripe listed, and our rows
      // that claim to be live. Dispatched on the filter each one uses.
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};
        if ('plan' in where) return opts.subscriptions ?? [];
        if ('stripeCustomerId' in where) return opts.subscriptionOwners ?? [];
        if ('status' in where) return opts.locallyLiveSubscriptions ?? [];
        if ('stripeSubscriptionId' in where) return opts.linkedSubscriptions ?? [];
        return opts.subscriptions ?? [];
      }),
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
    recordNumberRentals: vi.fn(async () => 0),
    costCoverage: vi.fn(async () => ({
      finalizedCalls: 0,
      callsMissingCost: 0,
      missingRatio: 0,
    })),
  };
  const creditLedger = {
    releaseReservation: vi.fn(async () => undefined),
  };

  // Only the list endpoints exist: any attempt to mutate Stripe from
  // reconciliation is a TypeError rather than a silent success.
  const stripe = {
    invoices: {
      list: vi.fn(async () => ({ data: opts.stripeInvoices ?? [], has_more: false })),
    },
    checkout: {
      sessions: {
        list: vi.fn(async () => ({ data: opts.stripeSessions ?? [], has_more: false })),
      },
    },
    subscriptions: {
      list: vi.fn(async () => ({
        data: opts.stripeSubscriptions ?? [],
        has_more: opts.stripeSubscriptionsHasMore ?? false,
      })),
    },
  };

  const service = new ReconciliationService(
    prisma as never,
    audit as never,
    metrics as never,
    providerCosts as never,
    creditLedger as never,
  );
  // Same seam the rest of the billing tests use: the real client is built from
  // STRIPE_SECRET_KEY in the constructor and replaced here.
  Object.assign(service as unknown as { stripe: unknown }, { stripe });

  return {
    prisma,
    tx,
    audit,
    metrics,
    providerCosts,
    creditLedger,
    stripe,
    balanceUpdate,
    balanceUpdateMany,
    bucketUpdateMany,
    callUsageUpdateMany,
    leaseUpdateMany,
    service,
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

  /**
   * A call that connected and then stopped reporting was left in `connected`
   * forever: nothing moved it to `finalized`, and `estimateMissingCallCosts`
   * only costs finalized rows, so the provider cost of a real, billed call was
   * never recorded — and `costCoverage`, whose denominator is also
   * finalized-only, showed 100% while doing it.
   */
  it('finalizes a call abandoned after connect without refunding its debits', async () => {
    const { service, callUsageUpdateMany, creditLedger, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 0, reservedSeconds: 0 }],
      staleCalls: [
        {
          id: 'usage-1',
          organizationId: ORG,
          callId: 'call-1',
          finalizationState: 'connected',
          connectedAt: new Date('2026-01-01T00:00:00.000Z'),
          billableSeconds: 120,
          reservedSeconds: 0,
          debitedSeconds: 120,
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
          disposition: 'abandoned_after_connect',
          // Billed minutes, not wall clock: the customer paid for exactly these.
          endedAt: new Date('2026-01-01T00:02:00.000Z'),
        }),
      }),
    );
    // The minutes were committed, so releasing the reservation would refund
    // revenue for a call that really happened.
    expect(creditLedger.releaseReservation).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.abandoned_call_finalized',
        resourceId: 'call-1',
      }),
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
        data: {
          status: 'review',
          reviewReason: 'stale_call_with_debits',
          version: { increment: 1 },
        },
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.manual_review_created' }),
    );
  });

  /**
   * The flag itself dedupes, so only the first reason is kept — but the early
   * return that used to follow the dedupe threw away every later incident's
   * audit record too, leaving one stale call and two hundred of them
   * indistinguishable to whoever clears the review.
   */
  it('audits a repeat incident on an organization already held for review', async () => {
    const { service, balanceUpdateMany, audit } = makeService({
      balances: [{ organizationId: ORG, availableSeconds: 0, reservedSeconds: 60 }],
      staleCalls: [
        {
          id: 'usage-2',
          organizationId: ORG,
          callId: 'call-2',
          reservedSeconds: 60,
          debitedSeconds: 120,
          createdAt: new Date(),
        },
      ],
    });
    // Already flagged: the `reviewReason: null` compare-and-set matches nothing.
    balanceUpdateMany.mockResolvedValueOnce({ count: 0 });

    const report = await service.finalizeStaleCalls();

    // No transition, so nothing new to report as created...
    expect(report.manualReviewsCreated).toBe(0);
    // ...but the incident is still on the record, with the call that caused it.
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.manual_review_incident',
        metadata: { callId: 'call-2', reason: 'stale_call_with_debits' },
      }),
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

    // One of the two abandonment shapes the sweep now reads in a single query.
    expect(prisma.callUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: expect.arrayContaining([
            expect.objectContaining({ finalizationState: { in: ['pending', 'releasing'] } }),
          ]),
        },
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

  it('books the monthly carrier number rentals and reports them', async () => {
    const { service, providerCosts, metrics } = makeService();
    providerCosts.recordNumberRentals.mockResolvedValueOnce(3);

    const report = await service.reconcileProviderCosts(25);

    // Every rental missing from the cost side is margin overstated by a
    // recurring charge nobody sees, so the sweep has to run in this pass and be
    // counted in this report.
    expect(providerCosts.recordNumberRentals).toHaveBeenCalledWith(25);
    expect(report.numberRentalsRecorded).toBe(3);
    expect(metrics.billingReconciliationCorrectionsTotal.labels).toHaveBeenCalledWith(
      'number_rental',
    );
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

describe('ReconciliationService.reportStripeDrift', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A paid invoice, a paid minute pack and a subscription, all for one org. */
  function driftFixture() {
    return {
      // Basil moved the subscription off the top level of the Invoice object; this
      // is the shape the pinned API version actually returns.
      stripeInvoices: [
        {
          id: 'in_1',
          customer: CUSTOMER,
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
          amount_paid: 9_900,
        },
      ],
      stripeSessions: [
        {
          id: 'cs_1',
          customer: CUSTOMER,
          payment_status: 'paid',
          metadata: { purchaseType: 'minute_pack' },
        },
      ],
      stripeSubscriptions: [
        { id: 'sub_1', status: 'past_due', items: { data: [{ price: { id: 'price_growth' } }] } },
      ],
      subscriptionOwners: [{ organizationId: ORG, stripeCustomerId: CUSTOMER }],
      linkedSubscriptions: [
        {
          organizationId: ORG,
          stripeSubscriptionId: 'sub_1',
          // Stripe says past_due; we are still serving them as active.
          status: 'active',
          stripePriceId: 'price_growth',
        },
      ],
      locallyLiveSubscriptions: [
        {
          organizationId: ORG,
          stripeSubscriptionId: 'sub_1',
          status: 'active',
          stripePriceId: 'price_growth',
        },
      ],
    };
  }

  it('counts money Stripe collected that bought no credit, and subscription state drift', async () => {
    const { service } = makeService({ ...driftFixture(), grantedBuckets: [] });

    const report = await service.reportStripeDrift();

    expect(report.stripeObjectsCompared).toBe(3);
    expect(report.stripePaidInvoicesWithoutCredit).toBe(1);
    expect(report.stripePaidPacksWithoutCredit).toBe(1);
    expect(report.stripeSubscriptionDrift).toBe(1);
  });

  it('never writes to our database or mutates Stripe when it finds drift', async () => {
    const {
      service,
      audit,
      balanceUpdate,
      balanceUpdateMany,
      bucketUpdateMany,
      callUsageUpdateMany,
      leaseUpdateMany,
    } = makeService({ ...driftFixture(), grantedBuckets: [] });

    const report = await service.reportStripeDrift();

    // Guard: without confirmed drift the assertions below would pass trivially.
    expect(report.stripePaidInvoicesWithoutCredit + report.stripeSubscriptionDrift).toBeGreaterThan(
      0,
    );
    // Report-only. Healing from a comparison this young would double-grant
    // credit or claw back credit the customer owns, so not one write is made —
    // not even an audit row, which records corrections that actually happened.
    expect(balanceUpdate).not.toHaveBeenCalled();
    expect(balanceUpdateMany).not.toHaveBeenCalled();
    expect(bucketUpdateMany).not.toHaveBeenCalled();
    expect(callUsageUpdateMany).not.toHaveBeenCalled();
    expect(leaseUpdateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('reports nothing, and locks nothing, when the credit was granted', async () => {
    const { service, prisma, tx } = makeService({
      ...driftFixture(),
      // Both payments produced their bucket, and Stripe agrees with our row.
      grantedBuckets: [
        { organizationId: ORG, sourceType: 'included', sourceId: 'in_1' },
        { organizationId: ORG, sourceType: 'purchased', sourceId: 'cs_1' },
      ],
      stripeSubscriptions: [
        { id: 'sub_1', status: 'active', items: { data: [{ price: { id: 'price_growth' } }] } },
      ],
    });

    const report = await service.reportStripeDrift();

    expect(report.stripePaidInvoicesWithoutCredit).toBe(0);
    expect(report.stripePaidPacksWithoutCredit).toBe(0);
    expect(report.stripeSubscriptionDrift).toBe(0);
    // An organization with nothing suspicious is never locked, so this pass
    // cannot make the real repairs skip it.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.billingCreditBucket.findUnique).not.toHaveBeenCalled();
  });

  it('skips the cancellation check when the Stripe subscription list is incomplete', async () => {
    const { service, prisma } = makeService({
      stripeSubscriptionsHasMore: true,
      stripeSubscriptions: [
        { id: 'sub_1', status: 'active', items: { data: [{ price: { id: 'price_growth' } }] } },
      ],
      linkedSubscriptions: [
        {
          organizationId: ORG,
          stripeSubscriptionId: 'sub_1',
          status: 'active',
          stripePriceId: 'price_growth',
        },
      ],
      // Absent from the (truncated) Stripe listing. A partial list is not
      // evidence of cancellation, so this must not be reported as drift.
      locallyLiveSubscriptions: [
        {
          organizationId: 'org-2',
          stripeSubscriptionId: 'sub_missing',
          status: 'active',
          stripePriceId: 'price_growth',
        },
      ],
    });

    const report = await service.reportStripeDrift(2);

    expect(report.stripeSubscriptionDrift).toBe(0);
    expect(prisma.subscription.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: expect.anything() }) }),
    );
  });

  it('no-ops cleanly when Stripe is not configured', async () => {
    const { service, prisma, stripe } = makeService({ ...driftFixture(), grantedBuckets: [] });
    Object.assign(service as unknown as { stripe: unknown }, { stripe: null });

    const report = await service.reportStripeDrift();

    expect(report).toEqual(emptyReconciliationReport());
    expect(stripe.invoices.list).not.toHaveBeenCalled();
    expect(prisma.billingCreditBucket.findMany).not.toHaveBeenCalled();
  });
});

describe('ReconciliationService.runAll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries the Stripe drift counters through the merge', async () => {
    const { service } = makeService();
    // The merge is a hand-written reducer: a counter the report type gained but
    // the reducer did not is silently dropped, and the drift would never
    // surface from a full pass.
    vi.spyOn(service, 'reportStripeDrift').mockResolvedValue({
      ...emptyReconciliationReport(),
      stripeObjectsCompared: 42,
      stripePaidInvoicesWithoutCredit: 3,
      stripePaidPacksWithoutCredit: 2,
      stripeSubscriptionDrift: 1,
    });

    const report = await service.runAll();

    expect(report.stripeObjectsCompared).toBe(42);
    expect(report.stripePaidInvoicesWithoutCredit).toBe(3);
    expect(report.stripePaidPacksWithoutCredit).toBe(2);
    expect(report.stripeSubscriptionDrift).toBe(1);
  });

  it('carries the number-rental counter through the merge', async () => {
    const { service, providerCosts } = makeService();
    providerCosts.recordNumberRentals.mockResolvedValueOnce(5);

    const report = await service.runAll();

    expect(report.numberRentalsRecorded).toBe(5);
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
    prisma.subscription.findMany.mockImplementation(async (args) =>
      args?.where?.['plan'] === 'starter' ? [{ organizationId: ORG, status: 'active' }] : [],
    );

    await service.publishMarginMetrics();

    expect(metrics.planContributionMarginRatio.labels).toHaveBeenCalledWith('starter');
    expect(set).toHaveBeenCalledWith(0);
  });

  /**
   * A trial bills nothing. Counting it at list price reported $99 of revenue
   * against real provider cost, so a plan whose trials were burning money for
   * free showed a positive margin — the gauge said the opposite of the truth.
   */
  it('excludes trials from revenue while keeping their provider cost', async () => {
    const set = vi.fn();
    const { service, metrics, prisma } = makeService({ costSum: 99 });
    metrics.planContributionMarginRatio.labels.mockReturnValue({ set });
    // One paying Starter subscription and one trial, $99 of cost across both.
    prisma.subscription.findMany.mockImplementation(async (args) =>
      args?.where?.['plan'] === 'starter'
        ? [
            { organizationId: ORG, status: 'active' },
            { organizationId: 'org-trial', status: 'trialing' },
          ]
        : [],
    );

    await service.publishMarginMetrics();

    // $99 revenue, not $198: (99 - 99) / 99 = 0, and the trial's cost is in it.
    expect(set).toHaveBeenCalledWith(0);
    // The trial is still aggregated, so its burn is not hidden from the ratio.
    expect(prisma.providerCostEvent.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: { in: [ORG, 'org-trial'] },
        }),
      }),
    );
  });
});

describe('ReconciliationService.clearBalanceReview', () => {
  beforeEach(() => vi.clearAllMocks());

  const stuck = (status: string, reviewReason: string | null): BalanceRow[] => [
    { organizationId: ORG, availableSeconds: 300, reservedSeconds: 0, status, reviewReason },
  ];

  // Both writers that push the status out of `active` have to be clearable:
  // `flagForReview` above writes `review`, and the partial-refund path in
  // credit-ledger writes `blocked`. entitlement.service refuses calls on any
  // non-`active` status, so either one is a total calling outage.
  it.each([
    ['review', 'stale_call_with_debits'],
    ['blocked', 'refund_manual_review:cs_123:120s'],
  ])('clears a %s balance and resets reviewReason', async (status, reason) => {
    const { service, prisma, balanceUpdateMany, audit } = makeService({
      balances: stuck(status, reason),
    });

    const result = await service.clearBalanceReview(ORG, 'ops@voiceforge.ai');

    expect(result).toEqual({
      cleared: true,
      previousStatus: status,
      previousReviewReason: reason,
    });
    expect(balanceUpdateMany).toHaveBeenCalledWith({
      // Compare-and-set on the values just read, so a concurrent flag or a
      // second operator loses the race rather than being overwritten.
      where: { organizationId: ORG, status, reviewReason: reason },
      data: { status: 'active', reviewReason: null, version: { increment: 1 } },
    });
    expect(audit.log).toHaveBeenCalledWith({
      organizationId: ORG,
      action: 'billing.manual_review_cleared',
      resourceType: 'organization_credit_balance',
      resourceId: ORG,
      metadata: {
        clearedBy: 'ops@voiceforge.ai',
        previousStatus: status,
        previousReviewReason: reason,
      },
    });
    // Restores permission to call; it does not hand out credit. Nothing but
    // the two status columns may move, and no other row may be touched.
    expect(prisma.organizationCreditBalance.update).not.toHaveBeenCalled();
    expect(prisma.billingCreditBucket.updateMany).not.toHaveBeenCalled();
  });

  it('clears a stale reviewReason left on an already-active balance', async () => {
    // reviewReason: null IS flagForReview's dedupe guard, so a non-null reason
    // on an active balance leaves review permanently disarmed for this org.
    const { service, balanceUpdateMany, audit } = makeService({
      balances: stuck('active', 'stale_call_with_debits'),
    });

    const result = await service.clearBalanceReview(ORG, 'ops@voiceforge.ai');

    expect(result.cleared).toBe(true);
    expect(balanceUpdateMany).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a balance that is already active and unflagged', async () => {
    const { service, balanceUpdateMany, audit } = makeService({
      balances: stuck('active', null),
    });

    const result = await service.clearBalanceReview(ORG, 'ops@voiceforge.ai');

    expect(result).toEqual({
      cleared: false,
      previousStatus: 'active',
      previousReviewReason: null,
    });
    expect(balanceUpdateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('does not invent a balance row for an organization that has none', async () => {
    const { service, balanceUpdateMany, audit } = makeService({ balances: [] });

    const result = await service.clearBalanceReview(ORG, 'ops@voiceforge.ai');

    expect(result).toEqual({
      cleared: false,
      previousStatus: null,
      previousReviewReason: null,
    });
    expect(balanceUpdateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('reports not-cleared and writes no audit entry when the compare-and-set loses', async () => {
    const { service, balanceUpdateMany, audit } = makeService({
      balances: stuck('review', 'stale_call_with_debits'),
    });
    balanceUpdateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.clearBalanceReview(ORG, 'ops@voiceforge.ai');

    // An audit entry for a write that did not happen is worse than none.
    expect(result.cleared).toBe(false);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
