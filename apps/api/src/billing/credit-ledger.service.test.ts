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
  readonly workspaces = new Map<string, { id: string; organizationId: string }>();
  readonly calls = new Map<
    string,
    { id: string; organizationId: string; workspaceId: string }
  >();

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

  readonly workspace = {
    findFirst: async (input: {
      where: { id: string; organizationId: string };
    }): Promise<{ id: string } | null> => {
      const workspace = this.workspaces.get(input.where.id);
      return workspace?.organizationId === input.where.organizationId
        ? { id: workspace.id }
        : null;
    },
  };

  readonly call = {
    findFirst: async (input: {
      where: {
        id: string;
        organizationId: string;
        workspaceId?: string;
      };
    }): Promise<{ id: string; workspaceId: string } | null> => {
      const call = this.calls.get(input.where.id);
      if (!call || call.organizationId !== input.where.organizationId) return null;
      if (
        input.where.workspaceId &&
        call.workspaceId !== input.where.workspaceId
      ) {
        return null;
      }
      return { id: call.id, workspaceId: call.workspaceId };
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

  seedRuntimeScope(input: {
    organizationId: string;
    workspaceId: string;
    callId: string;
  }): void {
    this.workspaces.set(input.workspaceId, {
      id: input.workspaceId,
      organizationId: input.organizationId,
    });
    this.calls.set(input.callId, {
      id: input.callId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
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
    prisma.seedRuntimeScope({
      organizationId: 'org-priority',
      workspaceId: 'workspace-priority',
      callId: 'call-priority',
    });
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
    prisma.seedRuntimeScope({
      organizationId: 'org-reserve',
      workspaceId: 'workspace-reserve',
      callId: 'call-reserve',
    });
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
    prisma.seedRuntimeScope({
      organizationId: 'org-commit',
      workspaceId: 'workspace-commit',
      callId: 'call-commit',
    });
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
    prisma.seedRuntimeScope({
      organizationId: 'org-release',
      workspaceId: 'workspace-release',
      callId: 'call-release',
    });
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
    prisma.seedRuntimeScope({
      organizationId: 'org-short',
      workspaceId: 'workspace-short',
      callId: 'call-short',
    });
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
    prisma.seedRuntimeScope({
      organizationId: 'org-concurrent',
      workspaceId: 'workspace-concurrent',
      callId: 'call-concurrent-a',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-concurrent',
      workspaceId: 'workspace-concurrent',
      callId: 'call-concurrent-b',
    });
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
    prisma.seedRuntimeScope({
      organizationId: 'org-review',
      workspaceId: 'workspace-review',
      callId: 'call-review',
    });
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
      available: 5_940,
      reserved: 0,
      totalOwned: 5_940,
    });
    expect(reversed.status).toBe('blocked');
    expect(reversed.reviewReason).toContain('60');
    expect(reversed.reviewReason).toContain('cs_review');
    expect(reversed.reviewReason).toContain('manual');
    expect(prisma.buckets[0]).toMatchObject({
      remainingSeconds: 5_940,
      status: 'active',
    });
  });

  it('rejects a conflicting reservation idempotency key reused across calls', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-reservation-conflict',
      sourceType: 'included',
      sourceId: 'in_reservation_conflict',
      seconds: 120,
      priority: 10,
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-reservation-conflict',
      workspaceId: 'workspace-reservation-conflict',
      callId: 'call-reservation-a',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-reservation-conflict',
      workspaceId: 'workspace-reservation-conflict',
      callId: 'call-reservation-b',
    });
    const idempotencyKey = 'reservation-conflict-key';
    await service.reserveInitialMinute({
      organizationId: 'org-reservation-conflict',
      workspaceId: 'workspace-reservation-conflict',
      callId: 'call-reservation-a',
      idempotencyKey,
    });

    await expect(
      service.reserveInitialMinute({
        organizationId: 'org-reservation-conflict',
        workspaceId: 'workspace-reservation-conflict',
        callId: 'call-reservation-b',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    const balance = await service.getBalance('org-reservation-conflict');
    expectExactSeconds(balance, {
      available: 60,
      reserved: 60,
      totalOwned: 120,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'reservation'),
    ).toHaveLength(1);
  });

  it('rejects a conflicting next-minute key reused for another event and call', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-runtime-conflict',
      sourceType: 'included',
      sourceId: 'in_runtime_conflict',
      seconds: 120,
      priority: 10,
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-runtime-conflict',
      workspaceId: 'workspace-runtime-conflict',
      callId: 'call-runtime-a',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-runtime-conflict',
      workspaceId: 'workspace-runtime-conflict',
      callId: 'call-runtime-b',
    });
    const idempotencyKey = 'runtime-conflict-key';
    await service.reserveAndDebitNextMinute({
      organizationId: 'org-runtime-conflict',
      workspaceId: 'workspace-runtime-conflict',
      callId: 'call-runtime-a',
      eventId: 'event-runtime-a',
      idempotencyKey,
    });

    await expect(
      service.reserveAndDebitNextMinute({
        organizationId: 'org-runtime-conflict',
        workspaceId: 'workspace-runtime-conflict',
        callId: 'call-runtime-b',
        eventId: 'event-runtime-b',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    const balance = await service.getBalance('org-runtime-conflict');
    expectExactSeconds(balance, {
      available: 60,
      reserved: 0,
      totalOwned: 60,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'usage_debit'),
    ).toHaveLength(1);
  });

  it('does not create a second initial reservation for the same call with a new key', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-one-reservation',
      sourceType: 'included',
      sourceId: 'in_one_reservation',
      seconds: 120,
      priority: 10,
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-one-reservation',
    });
    const first = await service.reserveInitialMinute({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-one-reservation',
      idempotencyKey: 'initial-reservation-key-a',
    });

    const replay = await service.reserveInitialMinute({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-one-reservation',
      idempotencyKey: 'initial-reservation-key-b',
    });

    expect(replay).toMatchObject({
      allowed: true,
      reason: 'allowed',
      seconds: 60,
      allocations: first.allocations,
    });
    expectExactSeconds(replay.creditBalance, {
      available: 60,
      reserved: 60,
      totalOwned: 120,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'reservation'),
    ).toHaveLength(1);
  });

  it('preserves a reserved purchased bucket during refund review and later release', async () => {
    const { prisma, service } = makeService();
    prisma.seedRuntimeScope({
      organizationId: 'org-reserved-refund',
      workspaceId: 'workspace-reserved-refund',
      callId: 'call-reserved-refund',
    });
    await service.grantPurchasedCredits({
      organizationId: 'org-reserved-refund',
      checkoutSessionId: 'cs_reserved_refund',
      purchasedAt: NOW,
    });
    await service.reserveInitialMinute({
      organizationId: 'org-reserved-refund',
      workspaceId: 'workspace-reserved-refund',
      callId: 'call-reserved-refund',
      idempotencyKey: 'reserved-refund-reservation',
    });

    const reviewBalance = await service.reversePurchasedCredits({
      organizationId: 'org-reserved-refund',
      checkoutSessionId: 'cs_reserved_refund',
      refundId: 're_reserved_refund',
    });

    expectExactSeconds(reviewBalance, {
      available: 5_940,
      reserved: 60,
      totalOwned: 6_000,
    });
    expect(reviewBalance.status).toBe('blocked');
    expect(prisma.buckets[0]).toMatchObject({
      remainingSeconds: 5_940,
      status: 'active',
    });
    expect(prisma.ledger.at(-1)).toMatchObject({
      entryType: 'purchase_reversal_review',
      seconds: 0,
    });

    const released = await service.releaseReservation({
      organizationId: 'org-reserved-refund',
      callId: 'call-reserved-refund',
      idempotencyKey: 'reserved-refund-release',
    });
    expectExactSeconds(released, {
      available: 6_000,
      reserved: 0,
      totalOwned: 6_000,
    });
    expect(released.status).toBe('blocked');
    expect(prisma.buckets[0]).toMatchObject({
      remainingSeconds: 6_000,
      status: 'active',
    });
  });

  it('rejects a cross-tenant workspace without mutating credit', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-workspace-owner',
      sourceType: 'included',
      sourceId: 'in_workspace_owner',
      seconds: 60,
      priority: 10,
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-workspace-owner',
      workspaceId: 'workspace-owner',
      callId: 'call-workspace-owner',
    });
    prisma.workspaces.set('workspace-foreign', {
      id: 'workspace-foreign',
      organizationId: 'org-foreign',
    });

    await expect(
      service.reserveInitialMinute({
        organizationId: 'org-workspace-owner',
        workspaceId: 'workspace-foreign',
        callId: 'call-workspace-owner',
        idempotencyKey: 'cross-tenant-workspace-key',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'tenant_scope_mismatch',
    });
    const balance = await service.getBalance('org-workspace-owner');
    expectExactSeconds(balance, {
      available: 60,
      reserved: 0,
      totalOwned: 60,
    });
    expect(prisma.ledger).toHaveLength(0);
  });

  it('rejects a cross-tenant call without mutating credit', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-call-owner',
      sourceType: 'included',
      sourceId: 'in_call_owner',
      seconds: 60,
      priority: 10,
    });
    prisma.workspaces.set('workspace-call-owner', {
      id: 'workspace-call-owner',
      organizationId: 'org-call-owner',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-foreign',
      workspaceId: 'workspace-foreign-call',
      callId: 'call-foreign',
    });

    await expect(
      service.reserveInitialMinute({
        organizationId: 'org-call-owner',
        workspaceId: 'workspace-call-owner',
        callId: 'call-foreign',
        idempotencyKey: 'cross-tenant-call-key',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'tenant_scope_mismatch',
    });
    const balance = await service.getBalance('org-call-owner');
    expectExactSeconds(balance, {
      available: 60,
      reserved: 0,
      totalOwned: 60,
    });
    expect(prisma.ledger).toHaveLength(0);
  });

  it('rejects reservation metadata whose allocations do not total 60 seconds', async () => {
    const { prisma, service } = makeService();
    prisma.seedRuntimeScope({
      organizationId: 'org-allocation-total',
      workspaceId: 'workspace-allocation-total',
      callId: 'call-allocation-total',
    });
    prisma.seedSeconds({
      organizationId: 'org-allocation-total',
      sourceType: 'included',
      sourceId: 'in_allocation_total',
      seconds: 60,
      priority: 10,
    });
    await service.reserveInitialMinute({
      organizationId: 'org-allocation-total',
      workspaceId: 'workspace-allocation-total',
      callId: 'call-allocation-total',
      idempotencyKey: 'allocation-total-reservation',
    });
    const reservation = prisma.ledger.find(
      (entry) => entry.entryType === 'reservation',
    )!;
    reservation.metadata = {
      allocations: [{ bucketId: prisma.buckets[0]!.id, seconds: 30 }],
    };

    await expect(
      service.commitReservation({
        organizationId: 'org-allocation-total',
        callId: 'call-allocation-total',
        idempotencyKey: 'allocation-total-commit',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'reservation_allocation_invalid',
    });
    const balance = await service.getBalance('org-allocation-total');
    expectExactSeconds(balance, {
      available: 0,
      reserved: 60,
      totalOwned: 60,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'reservation_commit'),
    ).toHaveLength(0);
  });

  it('rejects reservation metadata containing duplicate bucket IDs', async () => {
    const { prisma, service } = makeService();
    prisma.seedRuntimeScope({
      organizationId: 'org-allocation-duplicate',
      workspaceId: 'workspace-allocation-duplicate',
      callId: 'call-allocation-duplicate',
    });
    prisma.seedSeconds({
      organizationId: 'org-allocation-duplicate',
      sourceType: 'included',
      sourceId: 'in_allocation_duplicate',
      seconds: 60,
      priority: 10,
    });
    await service.reserveInitialMinute({
      organizationId: 'org-allocation-duplicate',
      workspaceId: 'workspace-allocation-duplicate',
      callId: 'call-allocation-duplicate',
      idempotencyKey: 'allocation-duplicate-reservation',
    });
    const reservation = prisma.ledger.find(
      (entry) => entry.entryType === 'reservation',
    )!;
    const bucketId = prisma.buckets[0]!.id;
    reservation.metadata = {
      allocations: [
        { bucketId, seconds: 30 },
        { bucketId, seconds: 30 },
      ],
    };

    await expect(
      service.releaseReservation({
        organizationId: 'org-allocation-duplicate',
        callId: 'call-allocation-duplicate',
        idempotencyKey: 'allocation-duplicate-release',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'reservation_allocation_invalid',
    });
    const balance = await service.getBalance('org-allocation-duplicate');
    expectExactSeconds(balance, {
      available: 0,
      reserved: 60,
      totalOwned: 60,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'reservation_release'),
    ).toHaveLength(0);
  });

  it('rejects a subscription grant key colliding with a non-subscription entry', async () => {
    const { prisma, service } = makeService();
    await prisma.billingLedgerEntry.create({
      data: {
        organizationId: 'org-subscription-collision',
        bucketId: null,
        workspaceId: null,
        callId: null,
        entryType: 'usage_debit',
        seconds: -60,
        balanceAfterSeconds: 0,
        actorType: 'system',
        actorId: null,
        reasonCode: 'minute_boundary',
        idempotencyKey: 'stripe:invoice:in_collision:included',
        metadata: {
          operation: {
            kind: 'next_minute_debit',
            organizationId: 'org-subscription-collision',
            callId: 'call-unrelated',
            eventId: 'event-unrelated',
          },
        },
      },
    });

    await expect(
      service.grantSubscriptionCredits({
        organizationId: 'org-subscription-collision',
        invoiceId: 'in_collision',
        includedMinutes: 10,
        periodEnd: PERIOD_END,
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    const balance = await service.getBalance('org-subscription-collision');
    expectExactSeconds(balance, {
      available: 0,
      reserved: 0,
      totalOwned: 0,
    });
    expect(prisma.buckets).toHaveLength(0);
    expect(prisma.ledger).toHaveLength(1);
  });

  it('rejects a purchased grant key bound to a different checkout identity', async () => {
    const { prisma, service } = makeService();
    await prisma.billingLedgerEntry.create({
      data: {
        organizationId: 'org-purchase-collision',
        bucketId: null,
        workspaceId: null,
        callId: null,
        entryType: 'purchase_grant',
        seconds: 6_000,
        balanceAfterSeconds: 6_000,
        actorType: 'stripe',
        actorId: 'cs_other',
        reasonCode: 'purchased_topup',
        idempotencyKey: 'stripe:checkout:cs_collision:topup',
        metadata: {
          checkoutSessionId: 'cs_other',
          purchasedAt: NOW.toISOString(),
        },
      },
    });

    await expect(
      service.grantPurchasedCredits({
        organizationId: 'org-purchase-collision',
        checkoutSessionId: 'cs_collision',
        purchasedAt: NOW,
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    const balance = await service.getBalance('org-purchase-collision');
    expectExactSeconds(balance, {
      available: 0,
      reserved: 0,
      totalOwned: 0,
    });
    expect(prisma.buckets).toHaveLength(0);
    expect(prisma.ledger).toHaveLength(1);
  });

  it('rejects a refund key reused for another checkout bucket', async () => {
    const { prisma, service } = makeService();
    await service.grantPurchasedCredits({
      organizationId: 'org-refund-collision',
      checkoutSessionId: 'cs_refund_a',
      purchasedAt: NOW,
    });
    await service.grantPurchasedCredits({
      organizationId: 'org-refund-collision',
      checkoutSessionId: 'cs_refund_b',
      purchasedAt: NOW,
    });
    await service.reversePurchasedCredits({
      organizationId: 'org-refund-collision',
      checkoutSessionId: 'cs_refund_a',
      refundId: 're_shared',
    });

    await expect(
      service.reversePurchasedCredits({
        organizationId: 'org-refund-collision',
        checkoutSessionId: 'cs_refund_b',
        refundId: 're_shared',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    const balance = await service.getBalance('org-refund-collision');
    expectExactSeconds(balance, {
      available: 6_000,
      reserved: 0,
      totalOwned: 6_000,
    });
    expect(
      prisma.buckets.find((bucket) => bucket.sourceId === 'cs_refund_b'),
    ).toMatchObject({
      status: 'active',
      remainingSeconds: 6_000,
    });
    expect(
      prisma.ledger.filter((entry) =>
        entry.entryType.startsWith('purchase_reversal'),
      ),
    ).toHaveLength(1);
  });

  it('rejects a commit key bound to an opposite lifecycle entry for another call', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-commit-collision',
      sourceType: 'included',
      sourceId: 'in_commit_collision',
      seconds: 120,
      priority: 10,
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-commit-collision',
      workspaceId: 'workspace-commit-collision',
      callId: 'call-commit-target',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-commit-collision',
      workspaceId: 'workspace-commit-collision',
      callId: 'call-release-source',
    });
    await service.reserveInitialMinute({
      organizationId: 'org-commit-collision',
      workspaceId: 'workspace-commit-collision',
      callId: 'call-commit-target',
      idempotencyKey: 'commit-target-reservation',
    });
    await service.reserveInitialMinute({
      organizationId: 'org-commit-collision',
      workspaceId: 'workspace-commit-collision',
      callId: 'call-release-source',
      idempotencyKey: 'release-source-reservation',
    });
    await service.releaseReservation({
      organizationId: 'org-commit-collision',
      callId: 'call-release-source',
      idempotencyKey: 'shared-lifecycle-key',
    });

    await expect(
      service.commitReservation({
        organizationId: 'org-commit-collision',
        callId: 'call-commit-target',
        idempotencyKey: 'shared-lifecycle-key',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    const balance = await service.getBalance('org-commit-collision');
    expectExactSeconds(balance, {
      available: 60,
      reserved: 60,
      totalOwned: 120,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'reservation_commit'),
    ).toHaveLength(0);
  });

  it('rejects a release key bound to an opposite lifecycle entry for another call', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-release-collision',
      sourceType: 'included',
      sourceId: 'in_release_collision',
      seconds: 120,
      priority: 10,
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-release-collision',
      workspaceId: 'workspace-release-collision',
      callId: 'call-release-target',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-release-collision',
      workspaceId: 'workspace-release-collision',
      callId: 'call-commit-source',
    });
    await service.reserveInitialMinute({
      organizationId: 'org-release-collision',
      workspaceId: 'workspace-release-collision',
      callId: 'call-release-target',
      idempotencyKey: 'release-target-reservation',
    });
    await service.reserveInitialMinute({
      organizationId: 'org-release-collision',
      workspaceId: 'workspace-release-collision',
      callId: 'call-commit-source',
      idempotencyKey: 'commit-source-reservation',
    });
    await service.commitReservation({
      organizationId: 'org-release-collision',
      callId: 'call-commit-source',
      idempotencyKey: 'shared-lifecycle-key',
    });

    await expect(
      service.releaseReservation({
        organizationId: 'org-release-collision',
        callId: 'call-release-target',
        idempotencyKey: 'shared-lifecycle-key',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    const balance = await service.getBalance('org-release-collision');
    expectExactSeconds(balance, {
      available: 0,
      reserved: 60,
      totalOwned: 60,
    });
    expect(
      prisma.ledger.filter(
        (entry) =>
          entry.entryType === 'reservation_release' &&
          entry.callId === 'call-release-target',
      ),
    ).toHaveLength(0);
  });

  it('replays exact purchased grant and refund operations without duplicate mutation', async () => {
    const { prisma, service } = makeService();
    const grantInput = {
      organizationId: 'org-exact-durable-replay',
      checkoutSessionId: 'cs_exact_durable_replay',
      purchasedAt: NOW,
    };
    const firstGrant = await service.grantPurchasedCredits(grantInput);
    const repeatedGrant = await service.grantPurchasedCredits(grantInput);
    expect(repeatedGrant).toEqual(firstGrant);
    expect(prisma.buckets).toHaveLength(1);
    expect(
      prisma.ledger.filter((entry) => entry.entryType === 'purchase_grant'),
    ).toHaveLength(1);

    const refundInput = {
      organizationId: 'org-exact-durable-replay',
      checkoutSessionId: 'cs_exact_durable_replay',
      refundId: 're_exact_durable_replay',
    };
    const firstRefund = await service.reversePurchasedCredits(refundInput);
    const repeatedRefund = await service.reversePurchasedCredits(refundInput);
    expect(repeatedRefund).toEqual(firstRefund);
    expectExactSeconds(repeatedRefund, {
      available: 0,
      reserved: 0,
      totalOwned: 0,
    });
    expect(
      prisma.ledger.filter((entry) =>
        entry.entryType.startsWith('purchase_reversal'),
      ),
    ).toHaveLength(1);
  });

  it('fails closed when a replayed denial has an unknown reason code', async () => {
    const { prisma, service } = makeService();
    prisma.seedRuntimeScope({
      organizationId: 'org-reason-replay',
      workspaceId: 'workspace-reason-replay',
      callId: 'call-reason-replay',
    });
    prisma.seedSeconds({
      organizationId: 'org-reason-replay',
      sourceType: 'included',
      sourceId: 'in_reason_replay',
      seconds: 59,
      priority: 10,
    });
    const input = {
      organizationId: 'org-reason-replay',
      workspaceId: 'workspace-reason-replay',
      callId: 'call-reason-replay',
      idempotencyKey: 'reason-replay-reservation',
    };
    await service.reserveInitialMinute(input);
    const denial = prisma.ledger.find(
      (entry) => entry.entryType === 'reservation_denied',
    )!;
    denial.reasonCode = 'unknown_denial_reason';

    await expect(service.reserveInitialMinute(input)).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'ledger_reason_invalid',
    });
    const balance = await service.getBalance('org-reason-replay');
    expectExactSeconds(balance, {
      available: 59,
      reserved: 0,
      totalOwned: 59,
    });
    expect(prisma.ledger).toHaveLength(1);
  });
});
