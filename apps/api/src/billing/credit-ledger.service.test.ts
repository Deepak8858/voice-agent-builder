import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditLedgerService,
  type CreditBalance,
} from './credit-ledger.service';

type BalanceRecord = {
  id: string;
  organizationId: string;
  availableSeconds: number;
  reservedSeconds: number;
  status: string;
  reviewReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type BucketRecord = {
  id: string;
  organizationId: string;
  sourceType: string;
  sourceId: string;
  originalSeconds: number;
  remainingSeconds: number;
  validFrom: Date;
  expiresAt: Date;
  priority: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type LedgerRecord = {
  id: string;
  organizationId: string;
  bucketId: string | null;
  workspaceId: string | null;
  callId: string | null;
  entryType: string;
  seconds: number;
  balanceAfterSeconds: number;
  actorType: string;
  actorId: string | null;
  reasonCode: string;
  idempotencyKey: string;
  metadata: unknown;
  createdAt: Date;
};

type NumberMutation = number | { increment?: number; decrement?: number };

function mutateNumber(current: number, mutation: NumberMutation | undefined): number {
  if (mutation === undefined) return current;
  if (typeof mutation === 'number') return mutation;
  return current + (mutation.increment ?? 0) - (mutation.decrement ?? 0);
}

class MemoryPrisma {
  readonly balances = new Map<string, BalanceRecord>();
  readonly buckets: BucketRecord[] = [];
  readonly ledger: LedgerRecord[] = [];

  private sequence = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  readonly organizationCreditBalance = {
    upsert: async (input: {
      where: { organizationId: string };
      create: { organizationId: string };
      update: Record<string, never>;
    }): Promise<BalanceRecord> => {
      const existing = this.balances.get(input.where.organizationId);
      if (existing) return structuredClone(existing);

      const now = new Date();
      const created: BalanceRecord = {
        id: this.nextId('balance'),
        organizationId: input.create.organizationId,
        availableSeconds: 0,
        reservedSeconds: 0,
        status: 'active',
        reviewReason: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.balances.set(created.organizationId, created);
      return structuredClone(created);
    },
    findUnique: async (input: {
      where: { organizationId: string };
    }): Promise<BalanceRecord | null> => {
      const record = this.balances.get(input.where.organizationId);
      return record ? structuredClone(record) : null;
    },
    update: async (input: {
      where: { organizationId: string };
      data: {
        availableSeconds?: NumberMutation;
        reservedSeconds?: NumberMutation;
        version?: NumberMutation;
        status?: string;
        reviewReason?: string | null;
      };
    }): Promise<BalanceRecord> => {
      const current = this.requireBalance(input.where.organizationId);
      const updated: BalanceRecord = {
        ...current,
        availableSeconds: mutateNumber(current.availableSeconds, input.data.availableSeconds),
        reservedSeconds: mutateNumber(current.reservedSeconds, input.data.reservedSeconds),
        version: mutateNumber(current.version, input.data.version),
        status: input.data.status ?? current.status,
        reviewReason:
          input.data.reviewReason === undefined
            ? current.reviewReason
            : input.data.reviewReason,
        updatedAt: new Date(),
      };
      if (updated.availableSeconds < 0 || updated.reservedSeconds < 0) {
        throw new Error('negative credit projection');
      }
      this.balances.set(updated.organizationId, updated);
      return structuredClone(updated);
    },
  };

  readonly billingCreditBucket = {
    create: async (input: {
      data: Omit<BucketRecord, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<BucketRecord> => {
      const duplicate = this.buckets.find(
        (bucket) =>
          bucket.organizationId === input.data.organizationId &&
          bucket.sourceType === input.data.sourceType &&
          bucket.sourceId === input.data.sourceId,
      );
      if (duplicate) throw new Error('duplicate bucket');

      const now = new Date();
      const created: BucketRecord = {
        ...input.data,
        id: this.nextId('bucket'),
        createdAt: now,
        updatedAt: now,
      };
      this.buckets.push(created);
      return structuredClone(created);
    },
    findMany: async (input: {
      where: {
        organizationId: string;
        status?: string;
        validFrom?: { lte: Date };
        expiresAt?: { gt: Date };
        remainingSeconds?: { gt: number };
      };
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    }): Promise<BucketRecord[]> => {
      const filtered = this.buckets.filter((bucket) => {
        if (bucket.organizationId !== input.where.organizationId) return false;
        if (input.where.status && bucket.status !== input.where.status) return false;
        if (
          input.where.validFrom?.lte &&
          bucket.validFrom.getTime() > input.where.validFrom.lte.getTime()
        ) {
          return false;
        }
        if (
          input.where.expiresAt?.gt &&
          bucket.expiresAt.getTime() <= input.where.expiresAt.gt.getTime()
        ) {
          return false;
        }
        if (
          input.where.remainingSeconds?.gt !== undefined &&
          bucket.remainingSeconds <= input.where.remainingSeconds.gt
        ) {
          return false;
        }
        return true;
      });
      filtered.sort(
        (left, right) =>
          left.priority - right.priority ||
          left.expiresAt.getTime() - right.expiresAt.getTime(),
      );
      return structuredClone(filtered);
    },
    findUnique: async (input: {
      where: {
        organizationId_sourceType_sourceId: {
          organizationId: string;
          sourceType: string;
          sourceId: string;
        };
      };
    }): Promise<BucketRecord | null> => {
      const key = input.where.organizationId_sourceType_sourceId;
      const bucket = this.buckets.find(
        (candidate) =>
          candidate.organizationId === key.organizationId &&
          candidate.sourceType === key.sourceType &&
          candidate.sourceId === key.sourceId,
      );
      return bucket ? structuredClone(bucket) : null;
    },
    update: async (input: {
      where: { id: string };
      data: { remainingSeconds?: NumberMutation; status?: string };
    }): Promise<BucketRecord> => {
      const index = this.buckets.findIndex((bucket) => bucket.id === input.where.id);
      if (index < 0) throw new Error(`missing bucket ${input.where.id}`);
      const current = this.buckets[index]!;
      const updated: BucketRecord = {
        ...current,
        remainingSeconds: mutateNumber(
          current.remainingSeconds,
          input.data.remainingSeconds,
        ),
        status: input.data.status ?? current.status,
        updatedAt: new Date(),
      };
      if (
        updated.remainingSeconds < 0 ||
        updated.remainingSeconds > updated.originalSeconds
      ) {
        throw new Error('invalid bucket balance');
      }
      this.buckets[index] = updated;
      return structuredClone(updated);
    },
    updateMany: async (input: {
      where: { id: string; organizationId: string };
      data: { remainingSeconds?: NumberMutation; status?: string };
    }): Promise<{ count: number }> => {
      const index = this.buckets.findIndex(
        (bucket) =>
          bucket.id === input.where.id &&
          bucket.organizationId === input.where.organizationId,
      );
      if (index < 0) return { count: 0 };
      const current = this.buckets[index]!;
      const updated: BucketRecord = {
        ...current,
        remainingSeconds: mutateNumber(
          current.remainingSeconds,
          input.data.remainingSeconds,
        ),
        status: input.data.status ?? current.status,
        updatedAt: new Date(),
      };
      if (
        updated.remainingSeconds < 0 ||
        updated.remainingSeconds > updated.originalSeconds
      ) {
        throw new Error('invalid bucket balance');
      }
      this.buckets[index] = updated;
      return { count: 1 };
    },
  };

  readonly billingLedgerEntry = {
    findUnique: async (input: {
      where: {
        organizationId_idempotencyKey: {
          organizationId: string;
          idempotencyKey: string;
        };
      };
    }): Promise<LedgerRecord | null> => {
      const key = input.where.organizationId_idempotencyKey;
      const entry = this.ledger.find(
        (candidate) =>
          candidate.organizationId === key.organizationId &&
          candidate.idempotencyKey === key.idempotencyKey,
      );
      return entry ? structuredClone(entry) : null;
    },
    findFirst: async (input: {
      where: Partial<
        Pick<
          LedgerRecord,
          'organizationId' | 'callId' | 'entryType' | 'reasonCode'
        >
      >;
      orderBy?: { createdAt: 'asc' | 'desc' };
    }): Promise<LedgerRecord | null> => {
      const matches = this.ledger.filter((entry) =>
        Object.entries(input.where).every(
          ([key, value]) => entry[key as keyof LedgerRecord] === value,
        ),
      );
      if (input.orderBy?.createdAt === 'desc') matches.reverse();
      return matches[0] ? structuredClone(matches[0]) : null;
    },
    create: async (input: {
      data: Omit<LedgerRecord, 'id' | 'createdAt'>;
    }): Promise<LedgerRecord> => {
      const duplicate = this.ledger.find(
        (entry) =>
          entry.organizationId === input.data.organizationId &&
          entry.idempotencyKey === input.data.idempotencyKey,
      );
      if (duplicate) throw new Error('duplicate ledger entry');
      const created: LedgerRecord = {
        ...input.data,
        id: this.nextId('ledger'),
        createdAt: new Date(),
      };
      this.ledger.push(created);
      return structuredClone(created);
    },
  };

  readonly $queryRaw = async (
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<Array<{ id: string }>> => [];

  async $transaction<T>(operation: (tx: MemoryPrisma) => Promise<T>): Promise<T> {
    let releaseLock: (() => void) | undefined;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previous;
    const snapshot = {
      balances: structuredClone(Array.from(this.balances.entries())),
      buckets: structuredClone(this.buckets),
      ledger: structuredClone(this.ledger),
    };
    try {
      return await operation(this);
    } catch (error) {
      this.balances.clear();
      for (const [key, value] of snapshot.balances) this.balances.set(key, value);
      this.buckets.splice(0, this.buckets.length, ...snapshot.buckets);
      this.ledger.splice(0, this.ledger.length, ...snapshot.ledger);
      throw error;
    } finally {
      releaseLock?.();
    }
  }

  seedSeconds(input: {
    organizationId: string;
    sourceType: 'included' | 'purchased';
    sourceId: string;
    seconds: number;
    priority: number;
  }): void {
    const now = new Date();
    this.balances.set(input.organizationId, {
      id: this.nextId('balance'),
      organizationId: input.organizationId,
      availableSeconds: input.seconds,
      reservedSeconds: 0,
      status: 'active',
      reviewReason: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.buckets.push({
      id: this.nextId('bucket'),
      organizationId: input.organizationId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      originalSeconds: input.seconds,
      remainingSeconds: input.seconds,
      validFrom: new Date('2026-07-01T00:00:00.000Z'),
      expiresAt: new Date('2027-07-01T00:00:00.000Z'),
      priority: input.priority,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private requireBalance(organizationId: string): BalanceRecord {
    const record = this.balances.get(organizationId);
    if (!record) throw new Error(`missing balance ${organizationId}`);
    return record;
  }
}

const NOW = new Date('2026-07-25T12:00:00.000Z');
const PERIOD_END = new Date('2026-08-25T12:00:00.000Z');

function makeService(): {
  prisma: MemoryPrisma;
  service: CreditLedgerService;
} {
  const prisma = new MemoryPrisma();
  return {
    prisma,
    service: new CreditLedgerService(prisma as never),
  };
}

function expectExactSeconds(
  balance: CreditBalance,
  expected: {
    available: number;
    reserved: number;
    totalOwned: number;
  },
): void {
  expect(balance.availableSeconds).toBe(expected.available);
  expect(balance.reservedSeconds).toBe(expected.reserved);
  expect(balance.totalOwnedSeconds).toBe(expected.totalOwned);
  expect(balance.availableSeconds).toBeGreaterThanOrEqual(0);
  expect(balance.reservedSeconds).toBeGreaterThanOrEqual(0);
}

describe('CreditLedgerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants one invoice exactly once', async () => {
    const { prisma, service } = makeService();
    const input = {
      organizationId: 'org-one',
      invoiceId: 'in_123',
      includedMinutes: 10,
      periodEnd: PERIOD_END,
    };

    const first = await service.grantSubscriptionCredits(input);
    const duplicate = await service.grantSubscriptionCredits(input);

    expectExactSeconds(first, {
      available: 600,
      reserved: 0,
      totalOwned: 600,
    });
    expect(duplicate).toEqual(first);
    expect(prisma.buckets).toMatchObject([
      {
        organizationId: 'org-one',
        sourceType: 'included',
        sourceId: 'in_123',
        originalSeconds: 600,
        remainingSeconds: 600,
        priority: 10,
        expiresAt: PERIOD_END,
      },
    ]);
    expect(prisma.ledger).toMatchObject([
      {
        organizationId: 'org-one',
        entryType: 'subscription_grant',
        seconds: 600,
        balanceAfterSeconds: 600,
        idempotencyKey: 'stripe:invoice:in_123:included',
      },
    ]);
  });

  it('consumes included buckets before purchased buckets', async () => {
    const { prisma, service } = makeService();
    await service.grantPurchasedCredits({
      organizationId: 'org-priority',
      checkoutSessionId: 'cs_pack',
      purchasedAt: NOW,
    });
    await service.grantSubscriptionCredits({
      organizationId: 'org-priority',
      invoiceId: 'in_included',
      includedMinutes: 1,
      periodEnd: PERIOD_END,
    });

    const decision = await service.reserveAndDebitNextMinute({
      organizationId: 'org-priority',
      workspaceId: 'workspace-priority',
      callId: 'call-priority',
      eventId: 'event-minute-2',
      idempotencyKey: 'runtime:event-minute-2:debit',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
    expect(decision.billableMinutes).toBe(1);
    expect(
      prisma.buckets.find((bucket) => bucket.sourceType === 'included')
        ?.remainingSeconds,
    ).toBe(0);
    expect(
      prisma.buckets.find((bucket) => bucket.sourceType === 'purchased')
        ?.remainingSeconds,
    ).toBe(6_000);
  });

  it('reserves 60 seconds without changing total owned credit', async () => {
    const { prisma, service } = makeService();
    await service.grantSubscriptionCredits({
      organizationId: 'org-reserve',
      invoiceId: 'in_reserve',
      includedMinutes: 1,
      periodEnd: PERIOD_END,
    });

    const reservation = await service.reserveInitialMinute({
      organizationId: 'org-reserve',
      workspaceId: 'workspace-reserve',
      callId: 'call-reserve',
      idempotencyKey: 'call:call-reserve:initial-reservation',
    });

    expect(reservation).toMatchObject({
      allowed: true,
      reason: 'allowed',
      seconds: 60,
      allocations: [{ seconds: 60 }],
    });
    expectExactSeconds(reservation.creditBalance, {
      available: 0,
      reserved: 60,
      totalOwned: 60,
    });
    expect(prisma.ledger.at(-1)).toMatchObject({
      entryType: 'reservation',
      seconds: 60,
      metadata: {
        allocations: [{ seconds: 60 }],
      },
    });
  });

  it('commits a reservation exactly once on connection', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-commit',
      sourceType: 'included',
      sourceId: 'in_commit',
      seconds: 60,
      priority: 10,
    });
    await service.reserveInitialMinute({
      organizationId: 'org-commit',
      workspaceId: 'workspace-commit',
      callId: 'call-commit',
      idempotencyKey: 'call:call-commit:initial-reservation',
    });

    const first = await service.commitReservation({
      organizationId: 'org-commit',
      callId: 'call-commit',
      idempotencyKey: 'call:call-commit:connect-commit',
    });
    const duplicate = await service.commitReservation({
      organizationId: 'org-commit',
      callId: 'call-commit',
      idempotencyKey: 'call:call-commit:connect-commit',
    });

    expectExactSeconds(first, {
      available: 0,
      reserved: 0,
      totalOwned: 0,
    });
    expect(duplicate).toEqual(first);
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'reservation_commit'),
    ).toHaveLength(1);
  });

  it('releases the full reservation when a call never connects', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-release',
      sourceType: 'included',
      sourceId: 'in_release',
      seconds: 60,
      priority: 10,
    });
    await service.reserveInitialMinute({
      organizationId: 'org-release',
      workspaceId: 'workspace-release',
      callId: 'call-release',
      idempotencyKey: 'call:call-release:initial-reservation',
    });

    const released = await service.releaseReservation({
      organizationId: 'org-release',
      callId: 'call-release',
      idempotencyKey: 'call:call-release:no-connect-release',
    });
    const duplicate = await service.releaseReservation({
      organizationId: 'org-release',
      callId: 'call-release',
      idempotencyKey: 'call:call-release:no-connect-release',
    });

    expectExactSeconds(released, {
      available: 60,
      reserved: 0,
      totalOwned: 60,
    });
    expect(duplicate).toEqual(released);
    expect(prisma.buckets[0]?.remainingSeconds).toBe(60);
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'reservation_release'),
    ).toHaveLength(1);
  });

  it('refuses a reservation when only 59 seconds are available', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-short',
      sourceType: 'included',
      sourceId: 'in_short',
      seconds: 59,
      priority: 10,
    });

    const reservation = await service.reserveInitialMinute({
      organizationId: 'org-short',
      workspaceId: 'workspace-short',
      callId: 'call-short',
      idempotencyKey: 'call:call-short:initial-reservation',
    });

    expect(reservation).toMatchObject({
      allowed: false,
      reason: 'credit_insufficient',
      seconds: 0,
      allocations: [],
    });
    expectExactSeconds(reservation.creditBalance, {
      available: 59,
      reserved: 0,
      totalOwned: 59,
    });
    expect(prisma.buckets[0]?.remainingSeconds).toBe(59);
  });

  it('never allows two concurrent reservations to overspend one balance', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-concurrent',
      sourceType: 'included',
      sourceId: 'in_concurrent',
      seconds: 60,
      priority: 10,
    });

    const reservations = await Promise.all([
      service.reserveInitialMinute({
        organizationId: 'org-concurrent',
        workspaceId: 'workspace-concurrent',
        callId: 'call-concurrent-a',
        idempotencyKey: 'call:call-concurrent-a:initial-reservation',
      }),
      service.reserveInitialMinute({
        organizationId: 'org-concurrent',
        workspaceId: 'workspace-concurrent',
        callId: 'call-concurrent-b',
        idempotencyKey: 'call:call-concurrent-b:initial-reservation',
      }),
    ]);

    expect(reservations.filter((reservation) => reservation.allowed)).toHaveLength(1);
    expect(
      reservations.filter(
        (reservation) => reservation.reason === 'credit_insufficient',
      ),
    ).toHaveLength(1);
    const balance = await service.getBalance('org-concurrent');
    expectExactSeconds(balance, {
      available: 0,
      reserved: 60,
      totalOwned: 60,
    });
    expect(prisma.buckets[0]?.remainingSeconds).toBe(0);
  });

  it('removes unused purchased credit on a refund', async () => {
    const { prisma, service } = makeService();
    await service.grantPurchasedCredits({
      organizationId: 'org-refund',
      checkoutSessionId: 'cs_refund',
      purchasedAt: NOW,
    });

    const reversed = await service.reversePurchasedCredits({
      organizationId: 'org-refund',
      checkoutSessionId: 'cs_refund',
      refundId: 're_unused',
    });

    expectExactSeconds(reversed, {
      available: 0,
      reserved: 0,
      totalOwned: 0,
    });
    expect(reversed.status).toBe('active');
    expect(prisma.buckets[0]).toMatchObject({
      remainingSeconds: 0,
      status: 'refunded',
    });
    expect(prisma.ledger.at(-1)).toMatchObject({
      entryType: 'purchase_reversal',
      seconds: -6_000,
      balanceAfterSeconds: 0,
      idempotencyKey: 'stripe:refund:re_unused:topup_reversal',
    });
  });

  it('blocks the organization for manual review when refunded credit was consumed', async () => {
    const { prisma, service } = makeService();
    await service.grantPurchasedCredits({
      organizationId: 'org-review',
      checkoutSessionId: 'cs_review',
      purchasedAt: NOW,
    });
    await service.reserveAndDebitNextMinute({
      organizationId: 'org-review',
      workspaceId: 'workspace-review',
      callId: 'call-review',
      eventId: 'event-review-minute',
      idempotencyKey: 'runtime:event-review-minute:debit',
    });

    const reversed = await service.reversePurchasedCredits({
      organizationId: 'org-review',
      checkoutSessionId: 'cs_review',
      refundId: 're_consumed',
    });

    expectExactSeconds(reversed, {
      available: 0,
      reserved: 0,
      totalOwned: 0,
    });
    expect(reversed.status).toBe('blocked');
    expect(reversed.reviewReason).toContain('60');
    expect(reversed.reviewReason).toContain('cs_review');
    expect(reversed.reviewReason).toContain('manual');
    expect(prisma.buckets[0]).toMatchObject({
      remainingSeconds: 0,
      status: 'refunded',
    });
  });
});
