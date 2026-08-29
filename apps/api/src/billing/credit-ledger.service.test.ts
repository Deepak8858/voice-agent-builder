import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditLedgerService,
  currentMonthKey,
  freeMonthlyGrantKey,
  monthBounds,
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
  stripePaymentIntentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type StripeEventRecord = { stripeEventId: string; processedAt: Date | null };

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

type TransactionEvent = {
  transactionId: number;
  action: string;
  organizationId: string;
  query?: string;
};

type TransactionContext = {
  id: number;
  upsertedOrganizationId: string | null;
  pendingBalance: BalanceRecord | null;
  lockedOrganizationId: string | null;
  releaseLock: (() => void) | null;
  snapshot: {
    balance: BalanceRecord | null;
    buckets: BucketRecord[];
    ledger: LedgerRecord[];
  } | null;
  /**
   * Stripe event rows this transaction's client changed, and what they were
   * before. Only these revert on rollback — a write issued through the root
   * client is its own transaction in Postgres and would survive, so undoing
   * every event row here would hide exactly the bug this models.
   */
  stripeEventUndo: Array<[string, StripeEventRecord]>;
};

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
  readonly calls = new Map<string, { id: string; organizationId: string; workspaceId: string }>();
  readonly stripeEvents = new Map<string, StripeEventRecord>();
  readonly transactionEvents: TransactionEvent[] = [];

  private sequence = 0;
  private transactionSequence = 0;
  /** Armed by {@link failNextBucketRead}; makes one bucket read blow up. */
  private pendingBucketReadFault: string | null = null;
  private readonly organizationLockTails = new Map<string, Promise<void>>();

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
          input.data.reviewReason === undefined ? current.reviewReason : input.data.reviewReason,
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
      // Mirrors credit_bucket_payment_intent_uidx: one bucket per real payment,
      // NULLs unconstrained. Without this the double would happily mint a second
      // paid-for pack from a replayed Checkout that the database would reject.
      const paymentIntentId = input.data.stripePaymentIntentId ?? null;
      if (
        paymentIntentId !== null &&
        this.buckets.some((bucket) => bucket.stripePaymentIntentId === paymentIntentId)
      ) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }

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
        sourceType?: string;
        validFrom?: { lte: Date };
        expiresAt?: { gt: Date };
        remainingSeconds?: { gt: number };
      };
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    }): Promise<BucketRecord[]> => {
      if (this.pendingBucketReadFault !== null) {
        const message = this.pendingBucketReadFault;
        this.pendingBucketReadFault = null;
        throw new Error(message);
      }
      const filtered = this.buckets.filter((bucket) => {
        if (bucket.organizationId !== input.where.organizationId) return false;
        if (input.where.status && bucket.status !== input.where.status) return false;
        if (input.where.sourceType && bucket.sourceType !== input.where.sourceType) return false;
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
          left.expiresAt.getTime() - right.expiresAt.getTime() ||
          left.id.localeCompare(right.id),
      );
      return structuredClone(filtered);
    },
    findFirst: async (input: {
      where: { organizationId: string; stripePaymentIntentId?: string | null };
      select?: { id: true };
    }): Promise<BucketRecord | null> => {
      const bucket = this.buckets.find(
        (candidate) =>
          candidate.organizationId === input.where.organizationId &&
          candidate.stripePaymentIntentId === (input.where.stripePaymentIntentId ?? null),
      );
      return bucket ? structuredClone(bucket) : null;
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
        remainingSeconds: mutateNumber(current.remainingSeconds, input.data.remainingSeconds),
        status: input.data.status ?? current.status,
        updatedAt: new Date(),
      };
      if (updated.remainingSeconds < 0 || updated.remainingSeconds > updated.originalSeconds) {
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
          bucket.id === input.where.id && bucket.organizationId === input.where.organizationId,
      );
      if (index < 0) return { count: 0 };
      const current = this.buckets[index]!;
      const updated: BucketRecord = {
        ...current,
        remainingSeconds: mutateNumber(current.remainingSeconds, input.data.remainingSeconds),
        status: input.data.status ?? current.status,
        updatedAt: new Date(),
      };
      if (updated.remainingSeconds < 0 || updated.remainingSeconds > updated.originalSeconds) {
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
      where: Partial<Pick<LedgerRecord, 'organizationId' | 'callId' | 'entryType' | 'reasonCode'>>;
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

  readonly stripeEvent = {
    updateMany: async (input: {
      where: { stripeEventId: string; processedAt: null };
      data: { processedAt: Date };
    }): Promise<{ count: number }> => {
      const record = this.stripeEvents.get(input.where.stripeEventId);
      if (!record || record.processedAt !== null) return { count: 0 };
      this.stripeEvents.set(input.where.stripeEventId, {
        ...record,
        processedAt: input.data.processedAt,
      });
      return { count: 1 };
    },
  };

  readonly workspace = {
    findFirst: async (input: {
      where: { id: string; organizationId: string };
    }): Promise<{ id: string } | null> => {
      const workspace = this.workspaces.get(input.where.id);
      return workspace?.organizationId === input.where.organizationId ? { id: workspace.id } : null;
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
      if (input.where.workspaceId && call.workspaceId !== input.where.workspaceId) {
        return null;
      }
      return { id: call.id, workspaceId: call.workspaceId };
    },
  };

  readonly $queryRaw = async (
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<Array<{ id: string }>> => {
    throw new Error('row locks must be acquired through a transaction client');
  };

  async $transaction<T>(operation: (tx: MemoryPrisma) => Promise<T>): Promise<T> {
    const context: TransactionContext = {
      id: ++this.transactionSequence,
      upsertedOrganizationId: null,
      pendingBalance: null,
      lockedOrganizationId: null,
      releaseLock: null,
      snapshot: null,
      stripeEventUndo: [],
    };
    try {
      return await operation(this.createTransactionClient(context));
    } catch (error) {
      this.restoreTransactionSnapshot(context);
      throw error;
    } finally {
      context.releaseLock?.();
    }
  }

  private createTransactionClient(context: TransactionContext): MemoryPrisma {
    const organizationCreditBalance: MemoryPrisma['organizationCreditBalance'] = {
      upsert: async (input) => {
        const organizationId = input.where.organizationId;
        this.recordTransactionEvent(context, 'balance.upsert', organizationId);
        if (context.lockedOrganizationId !== null) {
          throw new Error('balance upsert must occur before row lock');
        }
        if (
          context.upsertedOrganizationId !== null &&
          context.upsertedOrganizationId !== organizationId
        ) {
          throw new Error('transaction cannot upsert multiple organizations');
        }
        context.upsertedOrganizationId = organizationId;
        const existing = this.balances.get(organizationId);
        if (existing) return structuredClone(existing);
        if (!context.pendingBalance) {
          const now = new Date();
          context.pendingBalance = {
            id: this.nextId('balance'),
            organizationId,
            availableSeconds: 0,
            reservedSeconds: 0,
            status: 'active',
            reviewReason: null,
            version: 0,
            createdAt: now,
            updatedAt: now,
          };
        }
        return structuredClone(context.pendingBalance);
      },
      findUnique: async (input) => {
        this.assertLockedAccess(context, 'balance.findUnique', input.where.organizationId);
        return this.organizationCreditBalance.findUnique(input);
      },
      update: async (input) => {
        this.assertLockedAccess(context, 'balance.update', input.where.organizationId);
        return this.organizationCreditBalance.update(input);
      },
    };

    const billingCreditBucket: MemoryPrisma['billingCreditBucket'] = {
      create: async (input) => {
        this.assertLockedAccess(context, 'bucket.create', input.data.organizationId);
        return this.billingCreditBucket.create(input);
      },
      findMany: async (input) => {
        this.assertLockedAccess(context, 'bucket.findMany', input.where.organizationId);
        return this.billingCreditBucket.findMany(input);
      },
      findFirst: async (input) => {
        this.assertLockedAccess(context, 'bucket.findFirst', input.where.organizationId);
        return this.billingCreditBucket.findFirst(input);
      },
      findUnique: async (input) => {
        const organizationId = input.where.organizationId_sourceType_sourceId.organizationId;
        this.assertLockedAccess(context, 'bucket.findUnique', organizationId);
        return this.billingCreditBucket.findUnique(input);
      },
      update: async (input) => {
        const organizationId = this.buckets.find(
          (bucket) => bucket.id === input.where.id,
        )?.organizationId;
        this.assertLockedAccess(context, 'bucket.update', organizationId);
        return this.billingCreditBucket.update(input);
      },
      updateMany: async (input) => {
        this.assertLockedAccess(context, 'bucket.updateMany', input.where.organizationId);
        return this.billingCreditBucket.updateMany(input);
      },
    };

    const billingLedgerEntry: MemoryPrisma['billingLedgerEntry'] = {
      findUnique: async (input) => {
        const organizationId = input.where.organizationId_idempotencyKey.organizationId;
        this.assertLockedAccess(context, 'ledger.findUnique', organizationId);
        return this.billingLedgerEntry.findUnique(input);
      },
      findFirst: async (input) => {
        this.assertLockedAccess(context, 'ledger.findFirst', input.where.organizationId);
        return this.billingLedgerEntry.findFirst(input);
      },
      create: async (input) => {
        this.assertLockedAccess(context, 'ledger.create', input.data.organizationId);
        return this.billingLedgerEntry.create(input);
      },
    };

    const stripeEvent: MemoryPrisma['stripeEvent'] = {
      updateMany: async (input) => {
        // No organization on a Stripe event row, so it cannot assert a lock the
        // way the others do; the recorded event still proves it ran inside the
        // grant's transaction rather than after it.
        this.recordTransactionEvent(
          context,
          'stripe_event.mark_processed',
          context.lockedOrganizationId ?? 'unlocked',
        );
        const before = this.stripeEvents.get(input.where.stripeEventId);
        if (before) context.stripeEventUndo.push([before.stripeEventId, structuredClone(before)]);
        return this.stripeEvent.updateMany(input);
      },
    };

    const workspace: MemoryPrisma['workspace'] = {
      findFirst: async (input) => {
        this.assertLockedAccess(context, 'workspace.findFirst', input.where.organizationId);
        return this.workspace.findFirst(input);
      },
    };

    const call: MemoryPrisma['call'] = {
      findFirst: async (input) => {
        this.assertLockedAccess(context, 'call.findFirst', input.where.organizationId);
        return this.call.findFirst(input);
      },
    };

    return {
      organizationCreditBalance,
      billingCreditBucket,
      billingLedgerEntry,
      stripeEvent,
      workspace,
      call,
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        this.insertBalanceIfMissing(context, strings, values),
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        this.acquireOrganizationRowLock(context, strings, values),
    } as unknown as MemoryPrisma;
  }

  private async insertBalanceIfMissing(
    context: TransactionContext,
    strings: TemplateStringsArray,
    values: unknown[],
  ): Promise<number> {
    const query = strings
      .map((part, index) => (index < values.length ? `${part}$${index + 1}` : part))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    const expectedQuery =
      'INSERT INTO organization_credit_balances (id, organization_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, NOW()) ON CONFLICT (organization_id) DO NOTHING';
    const organizationId = values[0];
    if (query !== expectedQuery || values.length !== 1 || typeof organizationId !== 'string') {
      throw new Error(`unexpected balance initialization query: ${query}`);
    }
    if (context.lockedOrganizationId !== null) {
      throw new Error('balance initialization must occur before row lock');
    }
    context.upsertedOrganizationId = organizationId;
    if (this.balances.has(organizationId)) {
      this.recordTransactionEvent(context, 'balance.insert_if_missing', organizationId, query);
      return 0;
    }
    if (!context.pendingBalance) {
      const now = new Date();
      context.pendingBalance = {
        id: this.nextId('balance'),
        organizationId,
        availableSeconds: 0,
        reservedSeconds: 0,
        status: 'active',
        reviewReason: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
    }
    this.recordTransactionEvent(context, 'balance.insert_if_missing', organizationId, query);
    return 1;
  }

  private async acquireOrganizationRowLock(
    context: TransactionContext,
    strings: TemplateStringsArray,
    values: unknown[],
  ): Promise<Array<{ id: string }>> {
    const query = strings
      .map((part, index) => (index < values.length ? `${part}$${index + 1}` : part))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    const expectedQuery =
      'SELECT id FROM organization_credit_balances WHERE organization_id = $1::uuid FOR UPDATE';
    const organizationId = values[0];
    if (query !== expectedQuery || values.length !== 1 || typeof organizationId !== 'string') {
      throw new Error(`unexpected row-lock query: ${query}`);
    }
    if (context.upsertedOrganizationId !== organizationId) {
      throw new Error('organization projection upsert must precede row lock');
    }
    if (context.lockedOrganizationId !== null) {
      throw new Error('transaction attempted to acquire more than one row lock');
    }

    context.releaseLock = await this.acquireOrganizationLock(organizationId);
    context.lockedOrganizationId = organizationId;
    context.snapshot = this.snapshotOrganizationState(organizationId);
    if (!this.balances.has(organizationId) && context.pendingBalance) {
      this.balances.set(organizationId, structuredClone(context.pendingBalance));
    }
    this.recordTransactionEvent(context, 'organization.row_lock', organizationId, query);
    return [{ id: this.requireBalance(organizationId).id }];
  }

  private async acquireOrganizationLock(organizationId: string): Promise<() => void> {
    const previous = this.organizationLockTails.get(organizationId) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.organizationLockTails.set(organizationId, tail);
    await previous;
    return () => {
      releaseCurrent?.();
      if (this.organizationLockTails.get(organizationId) === tail) {
        this.organizationLockTails.delete(organizationId);
      }
    };
  }

  private assertLockedAccess(
    context: TransactionContext,
    action: string,
    organizationId: string | undefined,
  ): asserts organizationId is string {
    if (organizationId === undefined || context.lockedOrganizationId !== organizationId) {
      throw new Error(`${action} must follow the matching organization row lock`);
    }
    this.recordTransactionEvent(context, action, organizationId);
  }

  private recordTransactionEvent(
    context: TransactionContext,
    action: string,
    organizationId: string,
    query?: string,
  ): void {
    this.transactionEvents.push({
      transactionId: context.id,
      action,
      organizationId,
      ...(query ? { query } : {}),
    });
  }

  private snapshotOrganizationState(organizationId: string) {
    return structuredClone({
      balance: this.balances.get(organizationId) ?? null,
      buckets: this.buckets.filter((bucket) => bucket.organizationId === organizationId),
      ledger: this.ledger.filter((entry) => entry.organizationId === organizationId),
    });
  }

  private restoreTransactionSnapshot(context: TransactionContext): void {
    for (const [id, record] of context.stripeEventUndo.reverse()) {
      this.stripeEvents.set(id, record);
    }
    context.stripeEventUndo.length = 0;
    if (!context.snapshot || !context.lockedOrganizationId) return;
    const organizationId = context.lockedOrganizationId;
    if (context.snapshot.balance) {
      this.balances.set(organizationId, structuredClone(context.snapshot.balance));
    } else {
      this.balances.delete(organizationId);
    }
    const otherBuckets = this.buckets.filter((bucket) => bucket.organizationId !== organizationId);
    this.buckets.splice(
      0,
      this.buckets.length,
      ...otherBuckets,
      ...structuredClone(context.snapshot.buckets),
    );
    const otherLedger = this.ledger.filter((entry) => entry.organizationId !== organizationId);
    this.ledger.splice(
      0,
      this.ledger.length,
      ...otherLedger,
      ...structuredClone(context.snapshot.ledger),
    );
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
      stripePaymentIntentId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Arms a one-shot failure on the next bucket read. `grantPurchasedCredits`
   * reads buckets only in the balance projection it builds last, which is the
   * one point where a transaction can still roll back *after* it has
   * acknowledged its Stripe event.
   */
  failNextBucketRead(message: string): void {
    this.pendingBucketReadFault = message;
  }

  /** An unprocessed webhook row, so a grant has something to acknowledge. */
  seedStripeEvent(stripeEventId: string): void {
    this.stripeEvents.set(stripeEventId, { stripeEventId, processedAt: null });
  }

  seedRuntimeScope(input: { organizationId: string; workspaceId: string; callId: string }): void {
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
/** The UTC calendar month {@link NOW} falls in, and its half-open bounds. */
const CURRENT_MONTH_KEY = '2026-07';
const MONTH_START = new Date('2026-07-01T00:00:00.000Z');
const MONTH_END = new Date('2026-08-01T00:00:00.000Z');

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

function snapshotCreditState(prisma: MemoryPrisma) {
  return structuredClone({
    projection: Array.from(prisma.balances.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    buckets: [...prisma.buckets].sort((left, right) => left.id.localeCompare(right.id)),
    ledger: [...prisma.ledger].sort((left, right) => left.id.localeCompare(right.id)),
  });
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
    const stateAfterFirst = snapshotCreditState(prisma);
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
    expect(snapshotCreditState(prisma)).toEqual(stateAfterFirst);
  });

  it('records the payment intent that funded a purchased bucket', async () => {
    const { prisma, service } = makeService();

    await service.grantPurchasedCredits({
      organizationId: 'org-pi',
      checkoutSessionId: 'cs_pi',
      purchasedAt: NOW,
      paymentIntentId: 'pi_funded',
    });

    expect(prisma.buckets).toMatchObject([{ stripePaymentIntentId: 'pi_funded' }]);
  });

  /**
   * The Checkout session id is the only thing keying this grant, and Stripe can
   * deliver the same payment under a second session id (a recovered session, a
   * replay after a session was recreated). The idempotency key does not catch
   * that. Granting once is the money property and it held before, by way of the
   * unique index — but the rejection rolled the transaction back including the
   * acknowledgement, so Stripe redelivered the same event until it gave up. The
   * second delivery must settle instead: no second pack, and the event marked
   * processed.
   */
  it('acknowledges a second pack funded by a payment intent that already bought one', async () => {
    const { prisma, service } = makeService();
    await service.grantPurchasedCredits({
      organizationId: 'org-pi-replay',
      checkoutSessionId: 'cs_pi_first',
      purchasedAt: NOW,
      paymentIntentId: 'pi_once',
    });
    prisma.seedStripeEvent('evt_pi_replay');

    await service.grantPurchasedCredits({
      organizationId: 'org-pi-replay',
      checkoutSessionId: 'cs_pi_second',
      purchasedAt: NOW,
      paymentIntentId: 'pi_once',
      stripeEventId: 'evt_pi_replay',
    });

    expect(prisma.buckets).toHaveLength(1);
    expect(prisma.ledger.filter((entry) => entry.entryType === 'purchase_grant')).toHaveLength(1);
    expect(prisma.stripeEvents.get('evt_pi_replay')?.processedAt).toBeInstanceOf(Date);
    const balance = await service.getBalance('org-pi-replay');
    expectExactSeconds(balance, { available: 6_000, reserved: 0, totalOwned: 6_000 });
  });

  /**
   * The acknowledgement above is scoped to the organization, so it can never
   * hand another tenant's purchase to this one. A payment intent that funded a
   * different organization's pack has to fall through to the create and be
   * rejected by the index — one payment, one pack, whoever asks.
   */
  it('refuses a pack funded by another organization payment intent', async () => {
    const { prisma, service } = makeService();
    await service.grantPurchasedCredits({
      organizationId: 'org-pi-owner',
      checkoutSessionId: 'cs_pi_owner',
      purchasedAt: NOW,
      paymentIntentId: 'pi_owned',
    });

    await expect(
      service.grantPurchasedCredits({
        organizationId: 'org-pi-thief',
        checkoutSessionId: 'cs_pi_thief',
        purchasedAt: NOW,
        paymentIntentId: 'pi_owned',
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(prisma.buckets).toHaveLength(1);
    const balance = await service.getBalance('org-pi-thief');
    expectExactSeconds(balance, { available: 0, reserved: 0, totalOwned: 0 });
  });

  it('replays a checkout naming the same payment intent without granting twice', async () => {
    const { prisma, service } = makeService();
    const input = {
      organizationId: 'org-pi-idem',
      checkoutSessionId: 'cs_pi_idem',
      purchasedAt: NOW,
      paymentIntentId: 'pi_idem',
    };

    const first = await service.grantPurchasedCredits(input);
    const replay = await service.grantPurchasedCredits(input);

    expect(replay).toEqual(first);
    expect(prisma.buckets).toHaveLength(1);
  });

  it('rejects a replay that claims a different payment intent for the same checkout', async () => {
    const { prisma, service } = makeService();
    await service.grantPurchasedCredits({
      organizationId: 'org-pi-conflict',
      checkoutSessionId: 'cs_pi_conflict',
      purchasedAt: NOW,
      paymentIntentId: 'pi_original',
    });

    await expect(
      service.grantPurchasedCredits({
        organizationId: 'org-pi-conflict',
        checkoutSessionId: 'cs_pi_conflict',
        purchasedAt: NOW,
        paymentIntentId: 'pi_substituted',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    expect(prisma.buckets).toHaveLength(1);
  });

  /**
   * The webhook's "processed" write used to be a separate statement after the
   * grant's transaction committed. A crash in between left the event row
   * `processing`, and once its lease expired the next redelivery re-dispatched
   * an event whose credit had already been granted — every non-idempotent side
   * effect of that handler ran twice. Acknowledging inside the grant makes the
   * two commit together.
   */
  it('acknowledges the Stripe event inside the grant transaction', async () => {
    const { prisma, service } = makeService();
    prisma.seedStripeEvent('evt_grant');

    await service.grantSubscriptionCredits({
      organizationId: 'org-ack',
      invoiceId: 'in_ack',
      includedMinutes: 10,
      periodEnd: PERIOD_END,
      stripeEventId: 'evt_grant',
    });

    expect(prisma.stripeEvents.get('evt_grant')?.processedAt).toBeInstanceOf(Date);
    const actions = prisma.transactionEvents.map((event) => event.action);
    expect(actions).toContain('stripe_event.mark_processed');
    // Same transaction as the ledger write, and after it.
    const marked = prisma.transactionEvents.findIndex(
      (event) => event.action === 'stripe_event.mark_processed',
    );
    const ledgerWrite = prisma.transactionEvents.findIndex(
      (event) => event.action === 'ledger.create',
    );
    expect(ledgerWrite).toBeGreaterThanOrEqual(0);
    expect(marked).toBeGreaterThan(ledgerWrite);
    expect(prisma.transactionEvents[marked]!.transactionId).toBe(
      prisma.transactionEvents[ledgerWrite]!.transactionId,
    );
  });

  it('leaves the Stripe event unacknowledged when the grant rolls back', async () => {
    const { prisma, service } = makeService();
    prisma.seedStripeEvent('evt_rollback');
    // Fails after the grant has acknowledged the event but before the
    // transaction commits, which is the only shape in which the two can
    // disagree. Written through the root client instead of `tx`, the
    // acknowledgement would survive this and the grant would not.
    prisma.failNextBucketRead('connection reset while projecting balance');

    await expect(
      service.grantPurchasedCredits({
        organizationId: 'org-rollback',
        checkoutSessionId: 'cs_rollback',
        purchasedAt: NOW,
        paymentIntentId: 'pi_rollback',
        stripeEventId: 'evt_rollback',
      }),
    ).rejects.toThrow('connection reset while projecting balance');
    expect(prisma.stripeEvents.get('evt_rollback')?.processedAt).toBeNull();
    expect(prisma.buckets).toHaveLength(0);
  });

  /**
   * A mid-cycle upgrade makes Stripe issue a second invoice inside one billing
   * period. Keying the grant by invoice stops the *same* invoice granting twice
   * but not two invoices stacking, so an upgrade used to hand out a second full
   * allowance — cheapest immediately before period end.
   */
  it('forfeits the outgoing included allowance when the next invoice grants one', async () => {
    const { prisma, service } = makeService();
    await service.grantSubscriptionCredits({
      organizationId: 'org-upgrade',
      invoiceId: 'in_starter',
      includedMinutes: 200,
      periodEnd: PERIOD_END,
    });

    const upgraded = await service.grantSubscriptionCredits({
      organizationId: 'org-upgrade',
      invoiceId: 'in_growth',
      includedMinutes: 1_000,
      periodEnd: PERIOD_END,
    });

    expectExactSeconds(upgraded, {
      available: 60_000,
      reserved: 0,
      totalOwned: 60_000,
    });
    expect(prisma.buckets).toMatchObject([
      { sourceId: 'in_starter', remainingSeconds: 0, status: 'expired' },
      { sourceId: 'in_growth', remainingSeconds: 60_000, status: 'active' },
    ]);
    expect(prisma.ledger).toMatchObject([
      { idempotencyKey: 'stripe:invoice:in_starter:included', seconds: 12_000 },
      {
        idempotencyKey: 'stripe:invoice:in_growth:supersede',
        entryType: 'included_grant_superseded',
        seconds: -12_000,
      },
      { idempotencyKey: 'stripe:invoice:in_growth:included', seconds: 60_000 },
    ]);
  });

  /** Only the unused remainder is forfeited; spent seconds are already gone. */
  it('forfeits only the unspent part of a superseded allowance', async () => {
    const { prisma, service } = makeService();
    await service.grantSubscriptionCredits({
      organizationId: 'org-upgrade-partial',
      invoiceId: 'in_partial_a',
      includedMinutes: 10,
      periodEnd: PERIOD_END,
    });
    prisma.buckets[0]!.remainingSeconds = 100;
    prisma.balances.get('org-upgrade-partial')!.availableSeconds = 100;

    const upgraded = await service.grantSubscriptionCredits({
      organizationId: 'org-upgrade-partial',
      invoiceId: 'in_partial_b',
      includedMinutes: 10,
      periodEnd: PERIOD_END,
    });

    expectExactSeconds(upgraded, { available: 600, reserved: 0, totalOwned: 600 });
    expect(prisma.ledger).toMatchObject([
      { idempotencyKey: 'stripe:invoice:in_partial_a:included' },
      { idempotencyKey: 'stripe:invoice:in_partial_b:supersede', seconds: -100 },
      { idempotencyKey: 'stripe:invoice:in_partial_b:included' },
    ]);
  });

  it('grants the free monthly allowance once per organization per month', async () => {
    const { prisma, service } = makeService();
    const input = { organizationId: 'org-free', monthKey: CURRENT_MONTH_KEY };

    const first = await service.grantFreeMonthlyCredits(input);
    const stateAfterFirst = snapshotCreditState(prisma);
    const duplicate = await service.grantFreeMonthlyCredits(input);

    expectExactSeconds(first, { available: 600, reserved: 0, totalOwned: 600 });
    expect(first.includedMinutesRemaining).toBe(10);
    expect(duplicate).toEqual(first);
    expect(prisma.buckets).toMatchObject([
      {
        organizationId: 'org-free',
        sourceType: 'included',
        sourceId: 'free_grant_org-free_2026-07',
        originalSeconds: 600,
        remainingSeconds: 600,
        priority: 10,
        validFrom: MONTH_START,
        expiresAt: MONTH_END,
        status: 'active',
      },
    ]);
    expect(prisma.ledger).toMatchObject([
      {
        organizationId: 'org-free',
        entryType: 'free_monthly_grant',
        seconds: 600,
        balanceAfterSeconds: 600,
        actorType: 'system',
        reasonCode: 'free_monthly_included',
        idempotencyKey: 'free_grant_org-free_2026-07',
      },
    ]);
    expect(snapshotCreditState(prisma)).toEqual(stateAfterFirst);
  });

  /**
   * The whole point of keying by month: the allowance recurs. A second month
   * must produce a second grant even though the organization already received
   * one, or a free customer would get 10 minutes for life.
   */
  it('grants a separate allowance for each calendar month', async () => {
    const { prisma, service } = makeService();
    await service.grantFreeMonthlyCredits({
      organizationId: 'org-free-months',
      monthKey: '2026-07',
    });
    const balance = await service.grantFreeMonthlyCredits({
      organizationId: 'org-free-months',
      monthKey: '2026-08',
    });

    expect(prisma.buckets.map((bucket) => bucket.sourceId)).toEqual([
      'free_grant_org-free-months_2026-07',
      'free_grant_org-free-months_2026-08',
    ]);
    expect(prisma.buckets[1]).toMatchObject({
      validFrom: MONTH_END,
      expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    // Only July is currently valid, so August is owned but not yet spendable.
    // Total owned still reflects both grants.
    expect(balance.availableSeconds).toBe(1_200);
    expect(balance.includedMinutesRemaining).toBe(10);
  });

  /**
   * The mirror of the supersede sweep. An organization that paid for the period
   * and then lapsed reads as Free, so the monthly sweep offered it the free
   * allowance on top of the invoice bucket it still holds for that same period —
   * two included allowances in one month, which is exactly what the upgrade
   * direction forfeits a bucket to prevent. Spending the paid allowance first
   * must not turn a cancellation into a refill.
   */
  it('withholds the free allowance while a paid period still covers the month', async () => {
    const { prisma, service } = makeService();
    await service.grantSubscriptionCredits({
      organizationId: 'org-lapsed',
      invoiceId: 'in_lapsed',
      includedMinutes: 20,
      periodEnd: new Date('2026-07-28T00:00:00.000Z'),
    });
    // Burned to zero: the allowance was received, so there is nothing left to
    // top up even though the bucket is empty.
    prisma.buckets[0]!.remainingSeconds = 0;

    const balance = await service.grantFreeMonthlyCredits({
      organizationId: 'org-lapsed',
      monthKey: CURRENT_MONTH_KEY,
    });

    expect(prisma.buckets.map((bucket) => bucket.sourceId)).toEqual(['in_lapsed']);
    expect(prisma.ledger.map((entry) => entry.entryType)).toEqual(['subscription_grant']);
    expect(balance.availableSeconds).toBe(1_200);
  });

  /**
   * The withholding is scoped to the period that overlaps, not to having ever
   * paid: once the invoice bucket's period ends the organization is a free
   * customer and must receive the allowance again.
   */
  it('grants the free allowance for a month no paid period covers', async () => {
    const { prisma, service } = makeService();
    await service.grantSubscriptionCredits({
      organizationId: 'org-lapsed-later',
      invoiceId: 'in_lapsed_later',
      includedMinutes: 20,
      periodEnd: MONTH_START,
    });

    await service.grantFreeMonthlyCredits({
      organizationId: 'org-lapsed-later',
      monthKey: CURRENT_MONTH_KEY,
    });

    expect(prisma.buckets.map((bucket) => bucket.sourceId)).toEqual([
      'in_lapsed_later',
      'free_grant_org-lapsed-later_2026-07',
    ]);
  });

  it('rolls a December allowance into the following January', async () => {
    const { prisma, service } = makeService();
    await service.grantFreeMonthlyCredits({
      organizationId: 'org-free-december',
      monthKey: '2026-12',
    });

    expect(prisma.buckets[0]).toMatchObject({
      validFrom: new Date('2026-12-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('rejects a month key that is not a calendar month', async () => {
    const { prisma, service } = makeService();

    await expect(
      service.grantFreeMonthlyCredits({
        organizationId: 'org-free-invalid',
        monthKey: '2026-13',
      }),
    ).rejects.toThrow();
    expect(prisma.buckets).toHaveLength(0);
    expect(prisma.ledger).toHaveLength(0);
  });

  /**
   * Free minutes must be spent before purchased ones, exactly like invoiced
   * included minutes: the free grant expires at month end, so spending a
   * purchased pack first would silently forfeit credit the customer paid for.
   */
  it('spends the free monthly allowance before purchased credit', async () => {
    const { prisma, service } = makeService();
    prisma.seedRuntimeScope({
      organizationId: 'org-free-priority',
      workspaceId: 'workspace-free-priority',
      callId: 'call-free-priority',
    });
    await service.grantPurchasedCredits({
      organizationId: 'org-free-priority',
      checkoutSessionId: 'cs_free_priority',
      purchasedAt: NOW,
    });
    await service.grantFreeMonthlyCredits({
      organizationId: 'org-free-priority',
      monthKey: CURRENT_MONTH_KEY,
    });

    const decision = await service.reserveAndDebitNextMinute({
      organizationId: 'org-free-priority',
      workspaceId: 'workspace-free-priority',
      callId: 'call-free-priority',
      eventId: 'event-free-priority',
      idempotencyKey: 'runtime:event-free-priority:debit',
    });

    expect(decision.allowed).toBe(true);
    expect(
      prisma.buckets.find((bucket) => bucket.sourceType === 'included')?.remainingSeconds,
    ).toBe(540);
    expect(
      prisma.buckets.find((bucket) => bucket.sourceType === 'purchased')?.remainingSeconds,
    ).toBe(6_000);
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
      prisma.buckets.find((bucket) => bucket.sourceType === 'included')?.remainingSeconds,
    ).toBe(0);
    expect(
      prisma.buckets.find((bucket) => bucket.sourceType === 'purchased')?.remainingSeconds,
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
    const stateAfterFirst = snapshotCreditState(prisma);
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
    expect(prisma.ledger.filter((entry) => entry.entryType === 'reservation_commit')).toHaveLength(
      1,
    );
    expect(snapshotCreditState(prisma)).toEqual(stateAfterFirst);
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
    const stateAfterFirst = snapshotCreditState(prisma);
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
    expect(prisma.ledger.filter((entry) => entry.entryType === 'reservation_release')).toHaveLength(
      1,
    );
    expect(snapshotCreditState(prisma)).toEqual(stateAfterFirst);
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
      reservations.filter((reservation) => reservation.reason === 'credit_insufficient'),
    ).toHaveLength(1);
    const raceTrace =
      (
        prisma as unknown as {
          transactionEvents?: Array<{
            transactionId: number;
            action: string;
            organizationId?: string;
          }>;
        }
      ).transactionEvents ?? [];
    const raceTransactions = new Set(
      raceTrace
        .filter(
          (event) =>
            event.action === 'organization.row_lock' && event.organizationId === 'org-concurrent',
        )
        .map((event) => event.transactionId),
    );
    expect(raceTransactions.size).toBe(2);
    for (const transactionId of raceTransactions) {
      const actions = raceTrace
        .filter((event) => event.transactionId === transactionId)
        .map((event) => event.action);
      expect(actions.indexOf('balance.insert_if_missing')).toBeLessThan(
        actions.indexOf('organization.row_lock'),
      );
      expect(actions.indexOf('organization.row_lock')).toBeLessThan(
        actions.indexOf('balance.findUnique'),
      );
      expect(actions.indexOf('organization.row_lock')).toBeLessThan(
        actions.indexOf('bucket.findMany'),
      );
    }
    const balance = await service.getBalance('org-concurrent');
    expectExactSeconds(balance, {
      available: 0,
      reserved: 60,
      totalOwned: 60,
    });
    expect(prisma.buckets[0]?.remainingSeconds).toBe(0);
  });

  it('does not serialize transaction callbacks before a row lock is requested', async () => {
    const prisma = new MemoryPrisma();
    const entered: string[] = [];
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const first = prisma.$transaction(async () => {
      entered.push('first');
      await gate;
    });
    const second = prisma.$transaction(async () => {
      entered.push('second');
      await gate;
    });

    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    try {
      expect(entered).toEqual(['first', 'second']);
    } finally {
      releaseGate?.();
      await Promise.all([first, second]);
    }
  });

  it('traces projection upsert, the exact organization row lock, then shared reads and mutations', async () => {
    const { prisma, service } = makeService();
    prisma.seedRuntimeScope({
      organizationId: 'org-lock-trace',
      workspaceId: 'workspace-lock-trace',
      callId: 'call-lock-trace',
    });
    prisma.seedSeconds({
      organizationId: 'org-lock-trace',
      sourceType: 'included',
      sourceId: 'in-lock-trace',
      seconds: 60,
      priority: 10,
    });

    await service.reserveInitialMinute({
      organizationId: 'org-lock-trace',
      workspaceId: 'workspace-lock-trace',
      callId: 'call-lock-trace',
      idempotencyKey: 'reservation-lock-trace',
    });

    const trace =
      (
        prisma as unknown as {
          transactionEvents?: Array<{
            transactionId: number;
            action: string;
            organizationId?: string;
            query?: string;
          }>;
        }
      ).transactionEvents ?? [];
    expect(trace.map((event) => event.action)).toEqual([
      'balance.insert_if_missing',
      'organization.row_lock',
      'balance.findUnique',
      'workspace.findFirst',
      'call.findFirst',
      'ledger.findUnique',
      'ledger.findFirst',
      'ledger.findFirst',
      'bucket.findMany',
      'bucket.updateMany',
      'balance.update',
      'bucket.findMany',
      'ledger.create',
    ]);
    expect(trace[1]).toEqual({
      transactionId: trace[0]?.transactionId,
      action: 'organization.row_lock',
      organizationId: 'org-lock-trace',
      query:
        'SELECT id FROM organization_credit_balances WHERE organization_id = $1::uuid FOR UPDATE',
    });
  });

  it('uses bucket ID as the stable allocation tie-breaker in the test double', async () => {
    const { prisma, service } = makeService();
    const organizationId = 'org-stable-bucket-order';
    // Two packs, not two invoices: a second included grant now supersedes the
    // first (one period's allowance at a time), so only purchased buckets can
    // coexist with an identical priority and expiry for the ID to break.
    await service.grantPurchasedCredits({
      organizationId,
      checkoutSessionId: 'cs-stable-b',
      purchasedAt: NOW,
    });
    await service.grantPurchasedCredits({
      organizationId,
      checkoutSessionId: 'cs-stable-a',
      purchasedAt: NOW,
    });
    prisma.seedRuntimeScope({
      organizationId,
      workspaceId: 'workspace-stable-bucket-order',
      callId: 'call-stable-bucket-order',
    });
    const expectedFirstBucketId = prisma.buckets
      .map((bucket) => bucket.id)
      .sort((left, right) => left.localeCompare(right))[0]!;
    prisma.buckets.reverse();

    const reservation = await service.reserveInitialMinute({
      organizationId,
      workspaceId: 'workspace-stable-bucket-order',
      callId: 'call-stable-bucket-order',
      idempotencyKey: 'reservation-stable-bucket-order',
    });

    expect(reservation.allocations).toEqual([{ bucketId: expectedFirstBucketId, seconds: 60 }]);
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
    expect(prisma.ledger.filter((entry) => entry.entryType === 'reservation')).toHaveLength(1);
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
    expect(prisma.ledger.filter((entry) => entry.entryType === 'usage_debit')).toHaveLength(1);
  });

  it('does not let a denied initial reservation gain admission through a new key', async () => {
    const { prisma, service } = makeService();
    const input = {
      organizationId: 'org-denied-reservation-key',
      workspaceId: 'workspace-denied-reservation-key',
      callId: 'call-denied-reservation-key',
      idempotencyKey: 'denied-reservation-key-a',
    };
    prisma.seedRuntimeScope(input);
    prisma.seedSeconds({
      organizationId: input.organizationId,
      sourceType: 'included',
      sourceId: 'in_denied_reservation_key',
      seconds: 59,
      priority: 10,
    });
    const denied = await service.reserveInitialMinute(input);
    expect(denied).toMatchObject({ allowed: false, reason: 'credit_insufficient' });

    await service.grantSubscriptionCredits({
      organizationId: input.organizationId,
      invoiceId: 'in_denied_reservation_retry_credit',
      includedMinutes: 1,
      periodEnd: PERIOD_END,
    });
    const stateBeforeRetry = snapshotCreditState(prisma);

    await expect(
      service.reserveInitialMinute({
        ...input,
        idempotencyKey: 'denied-reservation-key-b',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    expect(snapshotCreditState(prisma)).toEqual(stateBeforeRetry);
    expect(
      prisma.ledger.filter(
        (entry) =>
          entry.callId === input.callId &&
          (entry.entryType === 'reservation' || entry.entryType === 'reservation_denied'),
      ),
    ).toHaveLength(1);
  });

  it('rejects a second reservation key without aliasing it and binds it only to a later exact call identity', async () => {
    const { prisma, service } = makeService();
    prisma.seedSeconds({
      organizationId: 'org-one-reservation',
      sourceType: 'included',
      sourceId: 'in_one_reservation',
      seconds: 180,
      priority: 10,
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-one-reservation',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-second-reservation',
    });
    prisma.seedRuntimeScope({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-third-reservation',
    });
    await service.reserveInitialMinute({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-one-reservation',
      idempotencyKey: 'initial-reservation-key-a',
    });
    const stateAfterFirst = snapshotCreditState(prisma);

    await expect(
      service.reserveInitialMinute({
        organizationId: 'org-one-reservation',
        workspaceId: 'workspace-one-reservation',
        callId: 'call-one-reservation',
        idempotencyKey: 'initial-reservation-key-b',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });

    expect(snapshotCreditState(prisma)).toEqual(stateAfterFirst);
    expect(
      prisma.ledger.find((entry) => entry.idempotencyKey === 'initial-reservation-key-b'),
    ).toBeUndefined();

    const second = await service.reserveInitialMinute({
      organizationId: 'org-one-reservation',
      workspaceId: 'workspace-one-reservation',
      callId: 'call-second-reservation',
      idempotencyKey: 'initial-reservation-key-b',
    });
    expect(second).toMatchObject({
      allowed: true,
      reason: 'allowed',
      seconds: 60,
    });
    expectExactSeconds(second.creditBalance, {
      available: 60,
      reserved: 120,
      totalOwned: 180,
    });
    const stateAfterSecond = snapshotCreditState(prisma);

    await expect(
      service.reserveInitialMinute({
        organizationId: 'org-one-reservation',
        workspaceId: 'workspace-one-reservation',
        callId: 'call-third-reservation',
        idempotencyKey: 'initial-reservation-key-b',
      }),
    ).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });

    expect(snapshotCreditState(prisma)).toEqual(stateAfterSecond);
    expect(prisma.ledger.filter((entry) => entry.entryType === 'reservation')).toHaveLength(2);
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
    const reservation = prisma.ledger.find((entry) => entry.entryType === 'reservation')!;
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
    expect(prisma.ledger.filter((entry) => entry.entryType === 'reservation_commit')).toHaveLength(
      0,
    );
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
    const reservation = prisma.ledger.find((entry) => entry.entryType === 'reservation')!;
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
    expect(prisma.ledger.filter((entry) => entry.entryType === 'reservation_release')).toHaveLength(
      0,
    );
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
    expect(prisma.buckets.find((bucket) => bucket.sourceId === 'cs_refund_b')).toMatchObject({
      status: 'active',
      remainingSeconds: 6_000,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType.startsWith('purchase_reversal')),
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
    expect(prisma.ledger.filter((entry) => entry.entryType === 'reservation_commit')).toHaveLength(
      0,
    );
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
          entry.entryType === 'reservation_release' && entry.callId === 'call-release-target',
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
    const stateAfterGrant = snapshotCreditState(prisma);
    const repeatedGrant = await service.grantPurchasedCredits(grantInput);
    expect(repeatedGrant).toEqual(firstGrant);
    expect(prisma.buckets).toHaveLength(1);
    expect(prisma.ledger.filter((entry) => entry.entryType === 'purchase_grant')).toHaveLength(1);
    expect(snapshotCreditState(prisma)).toEqual(stateAfterGrant);

    const refundInput = {
      organizationId: 'org-exact-durable-replay',
      checkoutSessionId: 'cs_exact_durable_replay',
      refundId: 're_exact_durable_replay',
    };
    const firstRefund = await service.reversePurchasedCredits(refundInput);
    const stateAfterRefund = snapshotCreditState(prisma);
    const repeatedRefund = await service.reversePurchasedCredits(refundInput);
    expect(repeatedRefund).toEqual(firstRefund);
    expectExactSeconds(repeatedRefund, {
      available: 0,
      reserved: 0,
      totalOwned: 0,
    });
    expect(
      prisma.ledger.filter((entry) => entry.entryType.startsWith('purchase_reversal')),
    ).toHaveLength(1);
    expect(snapshotCreditState(prisma)).toEqual(stateAfterRefund);
  });

  async function makeReversalReplayFixture(branch: 'automatic' | 'manual_review') {
    const { prisma, service } = makeService();
    const organizationId = `org-reversal-${branch}`;
    const checkoutSessionId = `cs-reversal-${branch}`;
    const refundId = `re-reversal-${branch}`;
    const refundInput = { organizationId, checkoutSessionId, refundId };
    await service.grantPurchasedCredits({
      organizationId,
      checkoutSessionId,
      purchasedAt: NOW,
    });

    let releaseReservation: (() => Promise<CreditBalance>) | undefined;
    if (branch === 'manual_review') {
      const workspaceId = `workspace-reversal-${branch}`;
      const callId = `call-reversal-${branch}`;
      prisma.seedRuntimeScope({ organizationId, workspaceId, callId });
      await service.reserveInitialMinute({
        organizationId,
        workspaceId,
        callId,
        idempotencyKey: `reservation-reversal-${branch}`,
      });
      releaseReservation = () =>
        service.releaseReservation({
          organizationId,
          callId,
          idempotencyKey: `release-reversal-${branch}`,
        });
    }

    await service.reversePurchasedCredits(refundInput);
    return {
      prisma,
      service,
      refundInput,
      releaseReservation,
      bucket: prisma.buckets[0]!,
      entry: prisma.ledger.find((candidate) =>
        candidate.entryType.startsWith('purchase_reversal'),
      )!,
    };
  }

  it.each(['automatic', 'manual_review'] as const)(
    'persists complete immutable %s reversal identity and replays without another mutation',
    async (branch) => {
      const fixture = await makeReversalReplayFixture(branch);
      expect(metadataRecord(fixture.entry).operation).toEqual({
        kind: 'purchased_credit_reversal',
        organizationId: fixture.refundInput.organizationId,
        checkoutSessionId: fixture.refundInput.checkoutSessionId,
        refundId: fixture.refundInput.refundId,
        bucketId: fixture.bucket.id,
        sourceType: 'purchased',
        sourceId: fixture.refundInput.checkoutSessionId,
        originalSeconds: 6_000,
      });
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await fixture.service.reversePurchasedCredits(fixture.refundInput);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
      expect(
        fixture.prisma.ledger.filter((entry) => entry.entryType.startsWith('purchase_reversal')),
      ).toHaveLength(1);
    },
  );

  type ReversalReplayFixture = Awaited<ReturnType<typeof makeReversalReplayFixture>>;
  type ReversalReplayMutation = readonly [
    label: string,
    mutate: (fixture: ReversalReplayFixture) => void,
  ];

  const commonReversalReplayMutations: ReversalReplayMutation[] = [
    [
      'the ledger workspace is non-null',
      ({ entry }) => (entry.workspaceId = 'workspace-unexpected'),
    ],
    ['the ledger call is non-null', ({ entry }) => (entry.callId = 'call-unexpected')],
    [
      'the source type identity is missing',
      ({ entry }) =>
        delete (metadataRecord(entry).operation as Record<string, unknown>)['sourceType'],
    ],
    [
      'the source ID identity is missing',
      ({ entry }) =>
        delete (metadataRecord(entry).operation as Record<string, unknown>)['sourceId'],
    ],
    [
      'the immutable original-seconds identity is missing',
      ({ entry }) =>
        delete (metadataRecord(entry).operation as Record<string, unknown>)['originalSeconds'],
    ],
    [
      'the checkout metadata is missing',
      ({ entry }) => delete metadataRecord(entry).checkoutSessionId,
    ],
    ['the refund metadata is missing', ({ entry }) => delete metadataRecord(entry).refundId],
    [
      'the original-seconds metadata is missing',
      ({ entry }) => delete metadataRecord(entry).originalSeconds,
    ],
  ];

  const automaticReversalReplayMutations: ReversalReplayMutation[] = [
    ...commonReversalReplayMutations,
    [
      'the entry type is the manual-review branch',
      ({ entry }) => (entry.entryType = 'purchase_reversal_review'),
    ],
    ['the ledger seconds differ', ({ entry }) => (entry.seconds = -5_999)],
    ['the ledger reason differs', ({ entry }) => (entry.reasonCode = 'refund_manual_review')],
    [
      'removed-seconds metadata is missing',
      ({ entry }) => delete metadataRecord(entry).unusedSecondsRemoved,
    ],
    [
      'removed-seconds metadata differs',
      ({ entry }) => (metadataRecord(entry).unusedSecondsRemoved = 5_999),
    ],
    [
      'consumed-seconds metadata is nonzero',
      ({ entry }) => (metadataRecord(entry).consumedOrReservedSeconds = 1),
    ],
    ['review metadata is non-null', ({ entry }) => (metadataRecord(entry).reviewReason = 'manual')],
  ];

  const manualReversalReplayMutations: ReversalReplayMutation[] = [
    ...commonReversalReplayMutations,
    [
      'the entry type is the automatic branch',
      ({ entry }) => (entry.entryType = 'purchase_reversal'),
    ],
    ['the ledger seconds are nonzero', ({ entry }) => (entry.seconds = -60)],
    ['the ledger reason differs', ({ entry }) => (entry.reasonCode = 'refund_unused_credit')],
    [
      'preserved-seconds metadata is missing',
      ({ entry }) => delete metadataRecord(entry).unusedSecondsPreserved,
    ],
    [
      'preserved and consumed seconds do not sum to the original',
      ({ entry }) => (metadataRecord(entry).unusedSecondsPreserved = 5_939),
    ],
    [
      'consumed-seconds metadata is zero',
      ({ entry }) => (metadataRecord(entry).consumedOrReservedSeconds = 0),
    ],
    [
      'the durable review reason differs',
      ({ entry }) => (metadataRecord(entry).reviewReason = 'manual'),
    ],
  ];

  it.each(automaticReversalReplayMutations)(
    'fails closed for automatic reversal replay when %s',
    async (_label, mutate) => {
      const fixture = await makeReversalReplayFixture('automatic');
      mutate(fixture);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(
        fixture.service.reversePurchasedCredits(fixture.refundInput),
      ).rejects.toMatchObject({ code: 'credit_ledger_invariant' });
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  it.each(manualReversalReplayMutations)(
    'fails closed for manual-review reversal replay when %s',
    async (_label, mutate) => {
      const fixture = await makeReversalReplayFixture('manual_review');
      mutate(fixture);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(
        fixture.service.reversePurchasedCredits(fixture.refundInput),
      ).rejects.toMatchObject({ code: 'credit_ledger_invariant' });
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  it('replays a manual-review reversal after release without consulting mutable bucket remaining state', async () => {
    const fixture = await makeReversalReplayFixture('manual_review');
    await fixture.releaseReservation!();
    expect(
      fixture.prisma.buckets.find((bucket) => bucket.id === fixture.bucket.id)?.remainingSeconds,
    ).toBe(6_000);
    const stateBeforeRetry = snapshotCreditState(fixture.prisma);

    await fixture.service.reversePurchasedCredits(fixture.refundInput);
    expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    expect(
      fixture.prisma.ledger.filter((entry) => entry.entryType.startsWith('purchase_reversal')),
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
    const denial = prisma.ledger.find((entry) => entry.entryType === 'reservation_denied')!;
    denial.reasonCode = 'unknown_denial_reason';
    const stateBeforeRetry = snapshotCreditState(prisma);

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
    expect(snapshotCreditState(prisma)).toEqual(stateBeforeRetry);
  });

  async function makeInitialReservationReplayFixture(outcome: 'allowed' | 'denied') {
    const { prisma, service } = makeService();
    const input = {
      organizationId: `org-initial-${outcome}-identity`,
      workspaceId: `workspace-initial-${outcome}-identity`,
      callId: `call-initial-${outcome}-identity`,
      idempotencyKey: `initial-${outcome}-identity`,
    };
    prisma.seedRuntimeScope(input);
    prisma.seedSeconds({
      organizationId: input.organizationId,
      sourceType: 'included',
      sourceId: `in-initial-${outcome}-identity`,
      seconds: outcome === 'allowed' ? 60 : 59,
      priority: 10,
    });
    const result = await service.reserveInitialMinute(input);
    return {
      prisma,
      service,
      input,
      result,
      entry: prisma.ledger[0]!,
    };
  }

  type InitialReplayMutation = readonly [label: string, mutate: (entry: LedgerRecord) => void];

  const allowedInitialReplayMutations: InitialReplayMutation[] = [
    ['a bucket column is present', (entry) => (entry.bucketId = 'bucket-unexpected')],
    ['ledger seconds are not plus 60', (entry) => (entry.seconds = 59)],
    ['the reason is not initial_minute', (entry) => (entry.reasonCode = 'minute_boundary')],
    [
      'the operation workspace differs',
      (entry) =>
        ((metadataRecord(entry).operation as Record<string, unknown>)['workspaceId'] =
          'workspace-foreign'),
    ],
    ['allocations are missing', (entry) => delete metadataRecord(entry).allocations],
    [
      'allocations do not total 60 seconds',
      (entry) => (metadataRecord(entry).allocations = [{ bucketId: 'bucket-short', seconds: 59 }]),
    ],
    [
      'allocation bucket IDs are duplicated',
      (entry) =>
        (metadataRecord(entry).allocations = [
          { bucketId: 'bucket-duplicate', seconds: 30 },
          { bucketId: 'bucket-duplicate', seconds: 30 },
        ]),
    ],
  ];

  it.each(allowedInitialReplayMutations)(
    'fails closed for allowed initial reservation replay when %s',
    async (_label, mutate) => {
      const fixture = await makeInitialReservationReplayFixture('allowed');
      mutate(fixture.entry);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(fixture.service.reserveInitialMinute(fixture.input)).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
      });
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  const deniedInitialReplayMutations: InitialReplayMutation[] = [
    ['a bucket column is present', (entry) => (entry.bucketId = 'bucket-unexpected')],
    ['ledger seconds are nonzero', (entry) => (entry.seconds = 1)],
    ['allocations are missing', (entry) => delete metadataRecord(entry).allocations],
    [
      'allocations are nonempty',
      (entry) =>
        (metadataRecord(entry).allocations = [{ bucketId: 'bucket-unexpected', seconds: 60 }]),
    ],
    [
      'the operation call differs',
      (entry) =>
        ((metadataRecord(entry).operation as Record<string, unknown>)['callId'] = 'call-foreign'),
    ],
  ];

  it.each(deniedInitialReplayMutations)(
    'fails closed for denied initial reservation replay when %s',
    async (_label, mutate) => {
      const fixture = await makeInitialReservationReplayFixture('denied');
      mutate(fixture.entry);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(fixture.service.reserveInitialMinute(fixture.input)).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
      });
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  it.each(['allowed', 'denied'] as const)(
    'keeps an exact %s initial reservation retry mutation-free',
    async (outcome) => {
      const fixture = await makeInitialReservationReplayFixture(outcome);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      const replay = await fixture.service.reserveInitialMinute(fixture.input);
      expect(replay).toEqual(fixture.result);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  type GrantReplayFixture = {
    prisma: MemoryPrisma;
    retry: () => Promise<CreditBalance>;
    entry: LedgerRecord;
    bucket: BucketRecord;
  };

  async function makeGrantReplayFixture(
    kind: 'subscription' | 'purchased' | 'free_monthly',
  ): Promise<GrantReplayFixture> {
    const { prisma, service } = makeService();
    if (kind === 'subscription') {
      const input = {
        organizationId: 'org-subscription-exact-replay',
        invoiceId: 'in_subscription_exact_replay',
        includedMinutes: 10,
        periodEnd: PERIOD_END,
      };
      await service.grantSubscriptionCredits(input);
      return {
        prisma,
        retry: () => service.grantSubscriptionCredits(input),
        entry: prisma.ledger[0]!,
        bucket: prisma.buckets[0]!,
      };
    }

    if (kind === 'free_monthly') {
      const input = {
        organizationId: 'org-free-monthly-exact-replay',
        monthKey: CURRENT_MONTH_KEY,
      };
      await service.grantFreeMonthlyCredits(input);
      return {
        prisma,
        retry: () => service.grantFreeMonthlyCredits(input),
        entry: prisma.ledger[0]!,
        bucket: prisma.buckets[0]!,
      };
    }

    const input = {
      organizationId: 'org-purchased-exact-replay',
      checkoutSessionId: 'cs_purchased_exact_replay',
      purchasedAt: NOW,
    };
    await service.grantPurchasedCredits(input);
    return {
      prisma,
      retry: () => service.grantPurchasedCredits(input),
      entry: prisma.ledger[0]!,
      bucket: prisma.buckets[0]!,
    };
  }

  function metadataRecord(entry: LedgerRecord): Record<string, unknown> {
    return entry.metadata as Record<string, unknown>;
  }

  type GrantReplayMutation = readonly [
    label: string,
    mutate: (fixture: GrantReplayFixture) => void,
  ];

  const subscriptionGrantReplayMutations: GrantReplayMutation[] = [
    ['the ledger bucket ID differs', ({ entry }) => (entry.bucketId = 'bucket-wrong')],
    ['the bucket source type differs', ({ bucket }) => (bucket.sourceType = 'purchased')],
    ['the bucket source ID differs', ({ bucket }) => (bucket.sourceId = 'in_other')],
    ['the bucket seconds differ', ({ bucket }) => (bucket.originalSeconds = 599)],
    [
      'the bucket expiry differs',
      ({ bucket }) => (bucket.expiresAt = new Date('2026-08-26T12:00:00.000Z')),
    ],
    ['the bucket priority differs', ({ bucket }) => (bucket.priority = 11)],
    ['the bucket status differs', ({ bucket }) => (bucket.status = 'refunded')],
    [
      'the ledger workspace is non-null',
      ({ entry }) => (entry.workspaceId = 'workspace-unexpected'),
    ],
    ['the ledger call is non-null', ({ entry }) => (entry.callId = 'call-unexpected')],
    ['the ledger seconds differ', ({ entry }) => (entry.seconds = 599)],
    ['the ledger reason differs', ({ entry }) => (entry.reasonCode = 'purchased_topup')],
    [
      'required financial metadata is missing',
      ({ entry }) => delete metadataRecord(entry).includedMinutes,
    ],
    [
      'the metadata seconds terms differ',
      ({ entry }) => (metadataRecord(entry).includedMinutes = 11),
    ],
    [
      'the metadata expiry terms differ',
      ({ entry }) => (metadataRecord(entry).periodEnd = '2026-08-26T12:00:00.000Z'),
    ],
    ['the metadata priority terms differ', ({ entry }) => (metadataRecord(entry).priority = 11)],
  ];

  it.each(subscriptionGrantReplayMutations)(
    'rejects subscription grant replay when %s',
    async (_label, mutate) => {
      const fixture = await makeGrantReplayFixture('subscription');
      mutate(fixture);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(fixture.retry()).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
        reasonCode: 'idempotency_conflict',
      });
      expect(fixture.prisma.ledger).toHaveLength(1);
      expect(fixture.prisma.buckets).toHaveLength(1);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  const purchasedGrantReplayMutations: GrantReplayMutation[] = [
    ['the ledger bucket ID differs', ({ entry }) => (entry.bucketId = 'bucket-wrong')],
    ['the bucket source type differs', ({ bucket }) => (bucket.sourceType = 'included')],
    ['the bucket source ID differs', ({ bucket }) => (bucket.sourceId = 'cs_other')],
    ['the bucket seconds differ', ({ bucket }) => (bucket.originalSeconds = 6_001)],
    [
      'the purchase time differs',
      ({ bucket }) => (bucket.validFrom = new Date('2026-07-25T12:00:01.000Z')),
    ],
    [
      'the bucket expiry differs',
      ({ bucket }) => (bucket.expiresAt = new Date('2027-07-26T12:00:00.000Z')),
    ],
    ['the bucket priority differs', ({ bucket }) => (bucket.priority = 21)],
    ['the bucket status differs', ({ bucket }) => (bucket.status = 'refunded')],
    [
      'the ledger workspace is non-null',
      ({ entry }) => (entry.workspaceId = 'workspace-unexpected'),
    ],
    ['the ledger call is non-null', ({ entry }) => (entry.callId = 'call-unexpected')],
    ['the ledger seconds differ', ({ entry }) => (entry.seconds = 5_999)],
    ['the ledger reason differs', ({ entry }) => (entry.reasonCode = 'subscription_included')],
    [
      'required financial metadata is missing',
      ({ entry }) => delete metadataRecord(entry).expiresAt,
    ],
    [
      'the metadata purchase time differs',
      ({ entry }) => (metadataRecord(entry).purchasedAt = '2026-07-25T12:00:01.000Z'),
    ],
    [
      'the metadata expiry terms differ',
      ({ entry }) => (metadataRecord(entry).expiresAt = '2027-07-26T12:00:00.000Z'),
    ],
    ['the metadata priority terms differ', ({ entry }) => (metadataRecord(entry).priority = 21)],
  ];

  it.each(purchasedGrantReplayMutations)(
    'rejects purchased grant replay when %s',
    async (_label, mutate) => {
      const fixture = await makeGrantReplayFixture('purchased');
      mutate(fixture);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(fixture.retry()).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
        reasonCode: 'idempotency_conflict',
      });
      expect(fixture.prisma.ledger).toHaveLength(1);
      expect(fixture.prisma.buckets).toHaveLength(1);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  const freeMonthlyGrantReplayMutations: GrantReplayMutation[] = [
    ['the ledger bucket ID differs', ({ entry }) => (entry.bucketId = 'bucket-wrong')],
    ['the bucket source type differs', ({ bucket }) => (bucket.sourceType = 'purchased')],
    [
      'the bucket source ID belongs to another month',
      ({ bucket }) => (bucket.sourceId = 'free_grant_org-free-monthly-exact-replay_2026-08'),
    ],
    [
      'the bucket period start differs',
      ({ bucket }) => (bucket.validFrom = new Date('2026-07-02T00:00:00.000Z')),
    ],
    [
      'the bucket period end differs',
      ({ bucket }) => (bucket.expiresAt = new Date('2026-09-01T00:00:00.000Z')),
    ],
    ['the bucket priority differs', ({ bucket }) => (bucket.priority = 20)],
    [
      'the ledger workspace is non-null',
      ({ entry }) => (entry.workspaceId = 'workspace-unexpected'),
    ],
    ['the ledger call is non-null', ({ entry }) => (entry.callId = 'call-unexpected')],
    ['the ledger seconds differ from the granted bucket', ({ entry }) => (entry.seconds = 599)],
    ['the ledger reason differs', ({ entry }) => (entry.reasonCode = 'subscription_included')],
    [
      'required month metadata is missing',
      ({ entry }) => delete metadataRecord(entry).monthKey,
    ],
    [
      'the metadata month differs',
      ({ entry }) => (metadataRecord(entry).monthKey = '2026-08'),
    ],
    [
      'the metadata period end differs',
      ({ entry }) => (metadataRecord(entry).periodEnd = '2026-09-01T00:00:00.000Z'),
    ],
    ['the metadata priority terms differ', ({ entry }) => (metadataRecord(entry).priority = 20)],
    [
      'the operation is a subscription grant wearing this key',
      ({ entry }) =>
        ((metadataRecord(entry).operation as Record<string, unknown>)['kind'] =
          'subscription_grant'),
    ],
  ];

  it.each(freeMonthlyGrantReplayMutations)(
    'rejects free monthly grant replay when %s',
    async (_label, mutate) => {
      const fixture = await makeGrantReplayFixture('free_monthly');
      mutate(fixture);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(fixture.retry()).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
        reasonCode: 'idempotency_conflict',
      });
      expect(fixture.prisma.ledger).toHaveLength(1);
      expect(fixture.prisma.buckets).toHaveLength(1);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  const exactGrantOperations = {
    subscription: {
      kind: 'subscription_grant',
      organizationId: 'org-subscription-exact-replay',
      invoiceId: 'in_subscription_exact_replay',
      sourceType: 'included',
      sourceId: 'in_subscription_exact_replay',
      seconds: 600,
      periodEnd: PERIOD_END.toISOString(),
      priority: 10,
      status: 'active',
    },
    purchased: {
      kind: 'purchased_grant',
      organizationId: 'org-purchased-exact-replay',
      checkoutSessionId: 'cs_purchased_exact_replay',
      sourceType: 'purchased',
      sourceId: 'cs_purchased_exact_replay',
      seconds: 6_000,
      purchasedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
      priority: 20,
      status: 'active',
    },
    free_monthly: {
      kind: 'free_monthly_grant',
      organizationId: 'org-free-monthly-exact-replay',
      monthKey: CURRENT_MONTH_KEY,
      sourceType: 'included',
      sourceId: 'free_grant_org-free-monthly-exact-replay_2026-07',
      seconds: 600,
      periodStart: MONTH_START.toISOString(),
      periodEnd: MONTH_END.toISOString(),
      priority: 10,
      status: 'active',
    },
  } as const;

  it.each(['subscription', 'purchased', 'free_monthly'] as const)(
    'persists exact %s grant operation terms and safely replays them',
    async (kind) => {
      const fixture = await makeGrantReplayFixture(kind);
      const operation = metadataRecord(fixture.entry).operation;

      expect(operation).toEqual({
        ...exactGrantOperations[kind],
        bucketId: fixture.bucket.id,
      });
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);
      await expect(fixture.retry()).resolves.toMatchObject({
        organizationId: fixture.entry.organizationId,
      });
      expect(fixture.prisma.ledger).toHaveLength(1);
      expect(fixture.prisma.buckets).toHaveLength(1);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  type FinalizationKind = 'reservation_commit' | 'reservation_release';

  async function makeFinalizationReplayFixture(kind: FinalizationKind) {
    const { prisma, service } = makeService();
    const organizationId = `org-${kind}-exact-replay`;
    const workspaceId = `workspace-${kind}-exact-replay`;
    const callId = `call-${kind}-exact-replay`;
    const reservationIdempotencyKey = `${kind}-initial-reservation`;
    const finalizationIdempotencyKey = `${kind}-finalization`;
    prisma.seedSeconds({
      organizationId,
      sourceType: 'included',
      sourceId: `${kind}-credits`,
      seconds: 60,
      priority: 10,
    });
    prisma.seedRuntimeScope({ organizationId, workspaceId, callId });
    const reservationInput = {
      organizationId,
      workspaceId,
      callId,
      idempotencyKey: reservationIdempotencyKey,
    };
    const reservationResult = await service.reserveInitialMinute(reservationInput);
    const finalize = (idempotencyKey: string) =>
      kind === 'reservation_commit'
        ? service.commitReservation({ organizationId, callId, idempotencyKey })
        : service.releaseReservation({
            organizationId,
            callId,
            idempotencyKey,
          });
    await finalize(finalizationIdempotencyKey);
    return {
      prisma,
      service,
      finalize,
      organizationId,
      workspaceId,
      callId,
      reservationIdempotencyKey,
      finalizationIdempotencyKey,
      reservationInput,
      reservationResult,
      reservationEntry: prisma.ledger.find((candidate) => candidate.entryType === 'reservation')!,
      entry: prisma.ledger.find((candidate) => candidate.entryType === kind)!,
    };
  }

  const finalizationReplayCases = [
    ['reservation_commit', 'exact'] as const,
    ['reservation_commit', 'semantic'] as const,
    ['reservation_release', 'exact'] as const,
    ['reservation_release', 'semantic'] as const,
  ];

  it.each(finalizationReplayCases)(
    'rejects %s %s replay with the wrong reservation key',
    async (kind, replayMode) => {
      const fixture = await makeFinalizationReplayFixture(kind);
      const operation = metadataRecord(fixture.entry).operation as Record<string, unknown>;
      operation.reservationIdempotencyKey = 'reservation-arbitrary';
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(
        fixture.finalize(
          replayMode === 'exact' ? fixture.finalizationIdempotencyKey : `${kind}-semantic-retry`,
        ),
      ).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
        reasonCode: 'idempotency_conflict',
      });
      expect(fixture.prisma.ledger.filter((entry) => entry.entryType === kind)).toHaveLength(1);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  it.each(finalizationReplayCases)(
    'rejects %s %s replay with a foreign persisted workspace',
    async (kind, replayMode) => {
      const fixture = await makeFinalizationReplayFixture(kind);
      fixture.entry.workspaceId = 'workspace-foreign';
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(
        fixture.finalize(
          replayMode === 'exact' ? fixture.finalizationIdempotencyKey : `${kind}-semantic-retry`,
        ),
      ).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
        reasonCode: 'idempotency_conflict',
      });
      expect(fixture.prisma.ledger.filter((entry) => entry.entryType === kind)).toHaveLength(1);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  type FinalizationReplayFixture = Awaited<ReturnType<typeof makeFinalizationReplayFixture>>;

  type FinalizationEntryMutation = readonly [
    label: string,
    mutate: (fixture: FinalizationReplayFixture) => void,
  ];

  const finalizationEntryMutations: FinalizationEntryMutation[] = [
    ['a bucket column is present', ({ entry }) => (entry.bucketId = 'bucket-unexpected')],
    ['the signed seconds differ', ({ entry }) => (entry.seconds = 0)],
    ['the reason differs', ({ entry }) => (entry.reasonCode = 'lifecycle-reason-wrong')],
    ['allocations are missing', ({ entry }) => delete metadataRecord(entry).allocations],
    [
      'allocations are malformed',
      ({ entry }) =>
        (metadataRecord(entry).allocations = [{ bucketId: 'bucket-malformed', seconds: 0 }]),
    ],
    [
      'allocations do not match the reservation',
      ({ entry }) =>
        (metadataRecord(entry).allocations = [{ bucketId: 'bucket-other', seconds: 60 }]),
    ],
    [
      'the top-level reservation key differs',
      ({ entry }) => (metadataRecord(entry).reservationIdempotencyKey = 'reservation-arbitrary'),
    ],
  ];

  it.each(
    (['reservation_commit', 'reservation_release'] as const).flatMap((kind) =>
      finalizationEntryMutations.map(([label, mutate]) => [kind, label, mutate] as const),
    ),
  )('fails closed for %s replay when %s', async (kind, _label, mutate) => {
    const fixture = await makeFinalizationReplayFixture(kind);
    mutate(fixture);
    const stateBeforeRetry = snapshotCreditState(fixture.prisma);

    await expect(fixture.finalize(fixture.finalizationIdempotencyKey)).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
    });
    expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
  });

  const persistedReservationMutations: FinalizationEntryMutation[] = [
    [
      'the reservation bucket column is non-null',
      ({ reservationEntry }) => (reservationEntry.bucketId = 'bucket-unexpected'),
    ],
    [
      'the reservation seconds are not plus 60',
      ({ reservationEntry }) => (reservationEntry.seconds = 59),
    ],
    [
      'the reservation reason differs',
      ({ reservationEntry }) => (reservationEntry.reasonCode = 'reservation-reason-wrong'),
    ],
    [
      'the reservation operation differs',
      ({ reservationEntry }) =>
        ((metadataRecord(reservationEntry).operation as Record<string, unknown>)['workspaceId'] =
          'workspace-foreign'),
    ],
    [
      'the reservation allocations are malformed',
      ({ reservationEntry }) =>
        (metadataRecord(reservationEntry).allocations = [
          { bucketId: 'bucket-short', seconds: 59 },
        ]),
    ],
  ];

  it.each(
    (['reservation_commit', 'reservation_release'] as const).flatMap((kind) =>
      persistedReservationMutations.map(([label, mutate]) => [kind, label, mutate] as const),
    ),
  )(
    'validates the persisted reservation before exact %s replay when %s',
    async (kind, _label, mutate) => {
      const fixture = await makeFinalizationReplayFixture(kind);
      mutate(fixture);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(fixture.finalize(fixture.finalizationIdempotencyKey)).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
      });
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  it.each(['reservation_commit', 'reservation_release'] as const)(
    'keeps exact %s retries idempotent with the original reservation identity',
    async (kind) => {
      const fixture = await makeFinalizationReplayFixture(kind);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);
      const replay = await fixture.finalize(fixture.finalizationIdempotencyKey);

      expect(replay.organizationId).toBe(fixture.organizationId);
      expect(fixture.prisma.ledger.filter((entry) => entry.entryType === kind)).toHaveLength(1);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  it.each(['reservation_commit', 'reservation_release'] as const)(
    'replays the exact original reservation after %s and rejects a different reservation key',
    async (kind) => {
      const fixture = await makeFinalizationReplayFixture(kind);
      const stateAfterFinalization = snapshotCreditState(fixture.prisma);

      const replay = await fixture.service.reserveInitialMinute(fixture.reservationInput);
      expect(replay).toEqual(fixture.reservationResult);
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateAfterFinalization);

      await expect(
        fixture.service.reserveInitialMinute({
          ...fixture.reservationInput,
          idempotencyKey: `${fixture.reservationIdempotencyKey}-different`,
        }),
      ).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
        reasonCode: 'idempotency_conflict',
      });
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateAfterFinalization);
    },
  );

  async function makeRuntimeDebitReplayFixture() {
    const { prisma, service } = makeService();
    const input = {
      organizationId: 'org-runtime-exact-replay',
      workspaceId: 'workspace-runtime-exact-replay',
      callId: 'call-runtime-exact-replay',
      eventId: 'event-runtime-exact-replay',
      idempotencyKey: 'runtime-exact-replay',
    };
    prisma.seedSeconds({
      organizationId: input.organizationId,
      sourceType: 'included',
      sourceId: 'in_runtime_exact_replay',
      seconds: 120,
      priority: 10,
    });
    prisma.seedRuntimeScope(input);
    await service.reserveAndDebitNextMinute(input);
    return {
      prisma,
      service,
      input,
      entry: prisma.ledger.find((candidate) => candidate.entryType === 'usage_debit')!,
    };
  }

  type RuntimeReplayMutation = readonly [
    label: string,
    mutate: (entry: LedgerRecord) => void,
    reasonCode: 'idempotency_conflict' | 'ledger_reason_invalid',
  ];

  const runtimeReplayMutations: RuntimeReplayMutation[] = [
    [
      'operation workspace is missing',
      (entry) => delete (metadataRecord(entry).operation as Record<string, unknown>).workspaceId,
      'idempotency_conflict',
    ],
    [
      'allocations are missing',
      (entry) => delete metadataRecord(entry).allocations,
      'idempotency_conflict',
    ],
    [
      'an allocation is malformed',
      (entry) =>
        (metadataRecord(entry).allocations = [{ bucketId: 'bucket-malformed', seconds: 0 }]),
      'idempotency_conflict',
    ],
    [
      'allocation bucket IDs are duplicated',
      (entry) =>
        (metadataRecord(entry).allocations = [
          { bucketId: 'bucket-duplicate', seconds: 30 },
          { bucketId: 'bucket-duplicate', seconds: 30 },
        ]),
      'idempotency_conflict',
    ],
    [
      'allocations do not total 60 seconds',
      (entry) => (metadataRecord(entry).allocations = [{ bucketId: 'bucket-short', seconds: 59 }]),
      'idempotency_conflict',
    ],
    ['ledger seconds are not minus 60', (entry) => (entry.seconds = -59), 'idempotency_conflict'],
    [
      'the ledger reason is not minute_boundary',
      (entry) => (entry.reasonCode = 'initial_minute'),
      'ledger_reason_invalid',
    ],
    [
      'a per-bucket ledger association is present',
      (entry) => (entry.bucketId = 'bucket-1'),
      'idempotency_conflict',
    ],
  ];

  it.each(runtimeReplayMutations)(
    'rejects allowed runtime debit replay when %s',
    async (_label, mutate, reasonCode) => {
      const fixture = await makeRuntimeDebitReplayFixture();
      mutate(fixture.entry);
      const stateBeforeRetry = snapshotCreditState(fixture.prisma);

      await expect(fixture.service.reserveAndDebitNextMinute(fixture.input)).rejects.toMatchObject({
        code: 'credit_ledger_invariant',
        reasonCode,
      });
      expect(fixture.prisma.ledger).toHaveLength(1);
      expect(fixture.prisma.balances.get(fixture.input.organizationId)).toMatchObject({
        availableSeconds: 60,
        reservedSeconds: 0,
      });
      expect(snapshotCreditState(fixture.prisma)).toEqual(stateBeforeRetry);
    },
  );

  it('rejects denied runtime debit replay with nonempty allocations', async () => {
    const { prisma, service } = makeService();
    const input = {
      organizationId: 'org-runtime-denial-replay',
      workspaceId: 'workspace-runtime-denial-replay',
      callId: 'call-runtime-denial-replay',
      eventId: 'event-runtime-denial-replay',
      idempotencyKey: 'runtime-denial-replay',
    };
    prisma.seedSeconds({
      organizationId: input.organizationId,
      sourceType: 'included',
      sourceId: 'in_runtime_denial_replay',
      seconds: 59,
      priority: 10,
    });
    prisma.seedRuntimeScope(input);
    await service.reserveAndDebitNextMinute(input);
    const denial = prisma.ledger.find((entry) => entry.entryType === 'usage_debit_denied')!;
    metadataRecord(denial).allocations = [{ bucketId: prisma.buckets[0]!.id, seconds: 60 }];
    const stateBeforeRetry = snapshotCreditState(prisma);

    await expect(service.reserveAndDebitNextMinute(input)).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    expect(prisma.ledger).toHaveLength(1);
    expect(prisma.balances.get(input.organizationId)).toMatchObject({
      availableSeconds: 59,
      reservedSeconds: 0,
    });
    expect(snapshotCreditState(prisma)).toEqual(stateBeforeRetry);
  });

  it('rejects denied runtime debit replay with nonzero ledger seconds', async () => {
    const { prisma, service } = makeService();
    const input = {
      organizationId: 'org-runtime-denial-seconds',
      workspaceId: 'workspace-runtime-denial-seconds',
      callId: 'call-runtime-denial-seconds',
      eventId: 'event-runtime-denial-seconds',
      idempotencyKey: 'runtime-denial-seconds',
    };
    prisma.seedRuntimeScope(input);
    await service.reserveAndDebitNextMinute(input);
    const denial = prisma.ledger[0]!;
    denial.seconds = -60;
    const stateBeforeRetry = snapshotCreditState(prisma);

    await expect(service.reserveAndDebitNextMinute(input)).rejects.toMatchObject({
      code: 'credit_ledger_invariant',
      reasonCode: 'idempotency_conflict',
    });
    expect(prisma.ledger).toHaveLength(1);
    expect(snapshotCreditState(prisma)).toEqual(stateBeforeRetry);
  });

  it('keeps exact allowed and denied runtime debit retries idempotent', async () => {
    const allowed = await makeRuntimeDebitReplayFixture();
    const allowedStateBeforeRetry = snapshotCreditState(allowed.prisma);
    await expect(allowed.service.reserveAndDebitNextMinute(allowed.input)).resolves.toMatchObject({
      allowed: true,
      billableMinutes: 1,
    });
    expect(allowed.prisma.ledger).toHaveLength(1);
    expect(snapshotCreditState(allowed.prisma)).toEqual(allowedStateBeforeRetry);

    const { prisma, service } = makeService();
    const deniedInput = {
      organizationId: 'org-runtime-denied-exact',
      workspaceId: 'workspace-runtime-denied-exact',
      callId: 'call-runtime-denied-exact',
      eventId: 'event-runtime-denied-exact',
      idempotencyKey: 'runtime-denied-exact',
    };
    prisma.seedRuntimeScope(deniedInput);
    await service.reserveAndDebitNextMinute(deniedInput);
    const deniedStateBeforeRetry = snapshotCreditState(prisma);
    await expect(service.reserveAndDebitNextMinute(deniedInput)).resolves.toMatchObject({
      allowed: false,
      reason: 'credit_insufficient',
      billableMinutes: 0,
    });
    expect(prisma.ledger).toHaveLength(1);
    expect(snapshotCreditState(prisma)).toEqual(deniedStateBeforeRetry);
  });
});

describe('currentMonthKey', () => {
  it('is stable across every instant within one UTC month', () => {
    expect(currentMonthKey(new Date('2026-07-01T00:00:00.000Z'))).toBe(
      currentMonthKey(new Date('2026-07-31T23:59:59.999Z')),
    );
  });

  it('changes at the UTC month boundary', () => {
    expect(currentMonthKey(new Date('2026-07-31T23:59:59.999Z'))).not.toBe(
      currentMonthKey(new Date('2026-08-01T00:00:00.000Z')),
    );
  });

  /**
   * The grant key must be derived in UTC. A local-time derivation would place
   * this instant in July for a host west of UTC, so the same month would be
   * granted twice under two different keys.
   */
  it('derives the month in UTC, not the host timezone', () => {
    expect(currentMonthKey(new Date('2026-08-01T00:30:00.000Z'))).toBe('2026-08');
  });

  it('zero-pads single-digit months', () => {
    expect(currentMonthKey(new Date('2026-03-15T00:00:00.000Z'))).toBe('2026-03');
  });
});

describe('monthBounds', () => {
  it('returns the half-open UTC bounds of the month', () => {
    expect(monthBounds('2026-07')).toEqual({
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
    });
  });

  it('rolls December into the next January rather than month 13', () => {
    expect(monthBounds('2026-12').periodEnd).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it.each(['2026-13', '2026-00', '2026-7', '26-07', 'not-a-month', ''])(
    'rejects %s instead of silently granting an arbitrary period',
    (monthKey) => {
      expect(() => monthBounds(monthKey)).toThrowError(
        expect.objectContaining({ reasonCode: 'free_grant_month_invalid' }),
      );
    },
  );
});

describe('freeMonthlyGrantKey', () => {
  it('is unique per organization and month', () => {
    expect(freeMonthlyGrantKey('org-a', '2026-07')).toBe('free_grant_org-a_2026-07');
    expect(freeMonthlyGrantKey('org-a', '2026-07')).not.toBe(
      freeMonthlyGrantKey('org-a', '2026-08'),
    );
    expect(freeMonthlyGrantKey('org-a', '2026-07')).not.toBe(
      freeMonthlyGrantKey('org-b', '2026-07'),
    );
  });
});
