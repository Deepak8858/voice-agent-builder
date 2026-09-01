import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOW_BALANCE_CHECK_JOB, LOW_BALANCE_QUEUE } from '../workers/low-balance.worker';
import { currentMonthKey } from './credit-ledger.service';
import { RuntimeUsageService } from './runtime-usage.service';

/**
 * `onMinuteBoundary` compares the reported minute against the API's own clock,
 * so a connect time in the fixtures has to be relative to now rather than a
 * fixed timestamp. One minute ago puts the call in minute 2, which is the
 * minute every boundary fixture below reports.
 */
const CONNECTED_ONE_MINUTE_AGO = () => new Date(Date.now() - 60_000);

const BALANCE = {
  organizationId: 'org-1',
  includedMinutesRemaining: 10,
  purchasedMinutesRemaining: 0,
};

interface StoredEvent {
  organizationId: string;
  eventId: string;
  decision: unknown;
  claimedAt: Date | null;
  processedAt: Date | null;
  attemptCount: number;
}

class UniqueConstraintError extends Error {
  readonly code = 'P2002';
}

/**
 * An in-memory stand-in for the `runtime_usage_events` table that enforces the
 * one property the service depends on: the `(organizationId, eventId)` unique
 * index. Without it a concurrency test would prove nothing, because both
 * deliveries would be allowed to claim the same event.
 */
function makeEventStore(seed?: { decision?: unknown }) {
  const rows = new Map<string, StoredEvent>();
  const key = (organizationId: string, eventId: string) => `${organizationId}:${eventId}`;

  if (seed?.decision) {
    rows.set(key('org-1', 'evt-1'), {
      organizationId: 'org-1',
      eventId: 'evt-1',
      decision: seed.decision,
      claimedAt: new Date(),
      processedAt: new Date(),
      attemptCount: 1,
    });
  }

  return {
    rows,
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const rowKey = key(data.organizationId as string, data.eventId as string);
      if (rows.has(rowKey)) throw new UniqueConstraintError('Unique constraint failed');
      rows.set(rowKey, {
        organizationId: data.organizationId as string,
        eventId: data.eventId as string,
        decision: null,
        claimedAt: (data.claimedAt as Date) ?? null,
        processedAt: null,
        attemptCount: (data.attemptCount as number) ?? 0,
      });
      return {};
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, never> }) => {
      const compound = (where as unknown as {
        organizationId_eventId: { organizationId: string; eventId: string };
      }).organizationId_eventId;
      return rows.get(key(compound.organizationId, compound.eventId)) ?? null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows.get(key(where.organizationId as string, where.eventId as string));
      if (!row) return { count: 0 };
      if (where.processedAt === null && row.processedAt !== null) return { count: 0 };
      // `OR: [claimedAt null, claimedAt <= leaseExpiry]` — an unexpired claim
      // held by someone else is not reclaimable.
      if (Array.isArray(where.OR) && row.claimedAt !== null) return { count: 0 };
      if ('claimedAt' in data) row.claimedAt = data.claimedAt as Date | null;
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, never>; data: Record<string, unknown> }) => {
      const compound = (where as unknown as {
        organizationId_eventId: { organizationId: string; eventId: string };
      }).organizationId_eventId;
      const row = rows.get(key(compound.organizationId, compound.eventId));
      if (row) {
        row.decision = data.decision;
        row.processedAt = data.processedAt as Date;
      }
      return {};
    }),
  };
}

function makeService(overrides?: {
  call?: unknown;
  replayDecision?: unknown;
  commitThrows?: boolean;
  nextMinuteAllowed?: boolean;
  /** Balance every ledger call reports; defaults to the healthy {@link BALANCE}. */
  balance?: typeof BALANCE;
  /** The low-balance enqueue fails, which must never fail metering. */
  enqueueThrows?: boolean;
  /** The ledger debit itself fails, so nothing was charged. */
  debitThrows?: boolean;
  /** The bookkeeping write fails after a committed debit. */
  usageWriteThrows?: boolean;
  /**
   * `connectedAt` on the stored usage row, which is what tells `call_ended`
   * whether the reserved first minute was ever committed. `undefined` keeps the
   * default connected row; `null` is a call that ended without connecting.
   */
  usageConnectedAt?: Date | null;
  /** No usage row at all, e.g. an end arriving after the row was purged. */
  usageMissing?: boolean;
}) {
  const runtimeUsageEvent = makeEventStore(
    overrides?.replayDecision ? { decision: overrides.replayDecision } : undefined,
  );
  const prisma = {
    call: {
      findFirst: vi.fn(async () =>
        overrides?.call === undefined
          ? { id: 'call-1', workspaceId: 'ws-1', organizationId: 'org-1' }
          : overrides.call,
      ),
    },
    runtimeUsageEvent,
    callUsage: {
      findFirst: vi.fn(async () =>
        overrides?.usageMissing
          ? null
          : {
              connectedAt:
                overrides?.usageConnectedAt === undefined
                  ? CONNECTED_ONE_MINUTE_AGO()
                  : overrides.usageConnectedAt,
            },
      ),
      updateMany: vi.fn(async () => {
        if (overrides?.usageWriteThrows) throw new Error('usage row unavailable');
        return { count: 1 };
      }),
    },
  };

  const balance = overrides?.balance ?? BALANCE;
  const creditLedger = {
    commitReservation: vi.fn(async () => balance),
    reserveAndDebitNextMinute: vi.fn(async () => ({
      eventId: 'evt-1',
      callId: 'call-1',
      organizationId: 'org-1',
      allowed: overrides?.nextMinuteAllowed ?? true,
      reason: (overrides?.nextMinuteAllowed ?? true) ? 'allowed' : 'credit_insufficient',
      billableMinutes: (overrides?.nextMinuteAllowed ?? true) ? 1 : 0,
      creditBalance: balance,
    })),
    getBalance: vi.fn(async () => balance),
  };
  if (overrides?.commitThrows) {
    creditLedger.commitReservation.mockRejectedValue(new Error('ledger unavailable'));
  }
  if (overrides?.debitThrows) {
    creditLedger.reserveAndDebitNextMinute.mockRejectedValue(new Error('ledger unavailable'));
  }

  const admission = {
    compensate: vi.fn(async () => undefined),
    releaseLease: vi.fn(async () => undefined),
  };

  const queues = {
    enqueue: vi.fn(async () => {
      if (overrides?.enqueueThrows) throw new Error('redis unavailable');
      return undefined;
    }),
  };

  const service = new RuntimeUsageService(
    prisma as never,
    creditLedger as never,
    admission as never,
    queues as never,
  );

  return { service, prisma, creditLedger, admission, queues };
}

describe('RuntimeUsageService.handleEvent', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('refuses an event whose call does not belong to the claimed organization', async () => {
    const { service, prisma, creditLedger, admission } = makeService({ call: null });

    await expect(
      service.handleEvent({
        type: 'call_connected',
        eventId: 'evt-1',
        callId: 'call-other',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:00.000Z',
        providerCallId: 'pc-1',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'billing_temporarily_unavailable' });

    expect(prisma.runtimeUsageEvent.create).not.toHaveBeenCalled();
    expect(creditLedger.commitReservation).not.toHaveBeenCalled();
    expect(admission.compensate).not.toHaveBeenCalled();
  });

  it('replays the stored decision instead of charging a retried event twice', async () => {
    const stored = {
      eventId: 'evt-1',
      callId: 'call-1',
      organizationId: 'org-1',
      allowed: true,
      reason: 'allowed',
      billableMinutes: 1,
      creditBalance: BALANCE,
    };
    const { service, prisma, creditLedger } = makeService({ replayDecision: stored });

    await expect(
      service.handleEvent({
        type: 'call_connected',
        eventId: 'evt-1',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:00.000Z',
        providerCallId: 'pc-1',
      }),
    ).resolves.toEqual(stored);

    expect(creditLedger.commitReservation).not.toHaveBeenCalled();
    expect(prisma.runtimeUsageEvent.update).not.toHaveBeenCalled();
  });

  it('commits the reserved first minute when the call connects', async () => {
    const { service, prisma, creditLedger } = makeService();

    await expect(
      service.handleEvent({
        type: 'call_connected',
        eventId: 'evt-1',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:00.000Z',
        providerCallId: 'pc-1',
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'allowed', billableMinutes: 1 });

    expect(creditLedger.commitReservation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'call:call-1:reservation_commit' }),
    );
    // The guard is `connectedAt: null` + `not: 'finalized'` rather than
    // `'pending'`, and the usage columns are incremented rather than assigned:
    // a delayed call_connected processed after a minute_boundary must not reset
    // accumulated usage back to 60 seconds.
    expect(prisma.callUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          connectedAt: null,
          finalizationState: { not: 'finalized' },
        }),
        data: expect.objectContaining({
          finalizationState: 'connected',
          billableSeconds: { increment: 60 },
          debitedSeconds: { increment: 60 },
        }),
      }),
    );
    expect(prisma.runtimeUsageEvent.update).toHaveBeenCalled();
  });

  it('reports a retryable failure and does not bill when the commit fails', async () => {
    const { service, prisma } = makeService({ commitThrows: true });

    await expect(
      service.handleEvent({
        type: 'call_connected',
        eventId: 'evt-1',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:00.000Z',
        providerCallId: 'pc-1',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'billing_temporarily_unavailable' });

    expect(prisma.callUsage.updateMany).not.toHaveBeenCalled();
  });

  /**
   * `commitReservation` turns the reserved first minute into revenue. Once it
   * returns, the money has moved, so a failure of the usage row that follows it
   * must not be reported as a billing failure: the commit and the bookkeeping
   * shared one catch, so the runtime was told
   * `billing_temporarily_unavailable` — and hung up — for a call whose first
   * minute the customer had already been charged for.
   */
  it('keeps a connected call allowed when the usage write fails after the commit', async () => {
    const { service, creditLedger, prisma } = makeService({ usageWriteThrows: true });

    await expect(
      service.handleEvent({
        type: 'call_connected',
        eventId: 'evt-1',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:00.000Z',
        providerCallId: 'pc-1',
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'allowed', billableMinutes: 1 });

    expect(creditLedger.commitReservation).toHaveBeenCalledTimes(1);
    expect(prisma.callUsage.updateMany).toHaveBeenCalled();
    // Loud enough to rebuild the row from the ledger the commit wrote to.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('after the first minute was committed for call call-1'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('usage row unavailable'));
  });

  it('debits each further minute under a per-minute idempotency key', async () => {
    const { service, creditLedger, prisma } = makeService();

    await expect(
      service.handleEvent({
        type: 'minute_boundary',
        eventId: 'evt-2',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:01:00.000Z',
        minute: 2,
      }),
    ).resolves.toMatchObject({ allowed: true });

    expect(creditLedger.reserveAndDebitNextMinute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        idempotencyKey: 'call:call-1:minute:2',
      }),
    );
    expect(prisma.callUsage.updateMany).toHaveBeenCalled();
  });

  /**
   * The debit and the bookkeeping write are two failure domains. Once the debit
   * has committed the customer has paid for the minute, so a failed write must
   * not come back as a billing failure: the runtime hangs up on
   * `metering_unavailable`, which would cut off a call that is funded and
   * charged for.
   */
  it('keeps a paid-for minute allowed when the bookkeeping write fails after the debit', async () => {
    const { service, prisma } = makeService({ usageWriteThrows: true });

    await expect(
      service.handleEvent({
        type: 'minute_boundary',
        eventId: 'evt-2',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:01:00.000Z',
        minute: 2,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'allowed', billableMinutes: 1 });

    expect(prisma.callUsage.updateMany).toHaveBeenCalled();
    // Loud enough to reconcile the missing row from the ledger: call, minute,
    // and the underlying error.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('minute 2 was debited for call call-1'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('usage row unavailable'));
  });

  it('denies the minute when the debit itself fails', async () => {
    const { service, prisma } = makeService({ debitThrows: true });

    await expect(
      service.handleEvent({
        type: 'minute_boundary',
        eventId: 'evt-2',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:01:00.000Z',
        minute: 2,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'billing_temporarily_unavailable' });

    expect(prisma.callUsage.updateMany).not.toHaveBeenCalled();
  });

  /**
   * The minute number is only an idempotency key, so a caller that keeps
   * reporting a minute it already paid for is deduped against its own debit and
   * talks for free. Wall clock is what bounds it.
   */
  it('bills the elapsed minute when a stale minute number is replayed', async () => {
    const { service, creditLedger } = makeService({
      usageConnectedAt: new Date(Date.now() - 3_600_000),
    });

    await expect(
      service.handleEvent({
        type: 'minute_boundary',
        eventId: 'evt-2',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:01:00.000Z',
        minute: 2,
      }),
    ).resolves.toMatchObject({ allowed: true });

    // An hour in, the call is in minute 61 — a key that has not been debited
    // yet, so the minute is actually charged.
    expect(creditLedger.reserveAndDebitNextMinute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'call:call-1:minute:61' }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reported minute 2 while wall clock puts it in minute 61'),
    );
  });

  it('leaves a boundary that is merely late on the minute it reported', async () => {
    // Two seconds into minute 3 while still reporting minute 2: a timer that
    // fired late, not arrears.
    const { service, creditLedger } = makeService({
      usageConnectedAt: new Date(Date.now() - 122_000),
    });

    await expect(
      service.handleEvent({
        type: 'minute_boundary',
        eventId: 'evt-2',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:01:00.000Z',
        minute: 2,
      }),
    ).resolves.toMatchObject({ allowed: true });

    expect(creditLedger.reserveAndDebitNextMinute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'call:call-1:minute:2' }),
    );
  });

  it('bills the reported minute when the boundary arrives before the connect event', async () => {
    // `call_connected` can be delivered after a boundary, so there is no
    // elapsed time to bound the minute with; refusing here would drop a call
    // purely on delivery order.
    const { service, creditLedger } = makeService({ usageConnectedAt: null });

    await expect(
      service.handleEvent({
        type: 'minute_boundary',
        eventId: 'evt-2',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:01:00.000Z',
        minute: 2,
      }),
    ).resolves.toMatchObject({ allowed: true });

    expect(creditLedger.reserveAndDebitNextMinute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'call:call-1:minute:2' }),
    );
  });

  it('does not increment billed seconds when a minute is refused', async () => {
    const { service, prisma } = makeService({ nextMinuteAllowed: false });

    await expect(
      service.handleEvent({
        type: 'minute_boundary',
        eventId: 'evt-2',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:01:00.000Z',
        minute: 2,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'credit_insufficient' });

    expect(prisma.callUsage.updateMany).not.toHaveBeenCalled();
  });

  it('finalizes usage and frees the concurrency slot when the call ends', async () => {
    const { service, prisma, admission } = makeService();

    await expect(
      service.handleEvent({
        type: 'call_ended',
        eventId: 'evt-3',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:05:00.000Z',
        durationSeconds: 305,
      }),
    ).resolves.toMatchObject({ allowed: true });

    expect(prisma.callUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawConnectedSeconds: 305,
          disposition: 'completed',
          finalizationState: 'finalized',
        }),
      }),
    );
    expect(admission.releaseLease).toHaveBeenCalledWith('org-1', 'call-1');
    // A completed call keeps its committed credit.
    expect(admission.compensate).not.toHaveBeenCalled();
  });

  /**
   * `call_ended` is not conditional on a successful `call_connected`: the
   * meter's shutdown callback fires on any teardown, so an end can arrive for a
   * call whose commit never happened. Finalizing that row without releasing the
   * reservation strands the minute permanently — `finalized` is outside the
   * window `finalizeStaleCalls` sweeps, and no reconciliation pass repairs
   * `reservedSeconds`.
   */
  it('returns the reserved minute when the call ends without ever connecting', async () => {
    const { service, prisma, admission } = makeService({ usageConnectedAt: null });

    await expect(
      service.handleEvent({
        type: 'call_ended',
        eventId: 'evt-3',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:04.000Z',
        durationSeconds: 0,
      }),
    ).resolves.toMatchObject({ allowed: true });

    // compensate() is the only path that releases the reservation, frees the
    // lease, and closes the usage row together.
    expect(admission.compensate).toHaveBeenCalledWith(
      'org-1',
      'call-1',
      'ended_without_connect',
    );
    // Nothing may mark this call completed: `finalized` is what hid the
    // stranded reservation from the stale-call sweep.
    expect(prisma.callUsage.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ finalizationState: 'finalized' }),
      }),
    );
    expect(prisma.callUsage.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ disposition: 'completed' }),
      }),
    );
    // The only write is the runtime-reported duration; compensation owns
    // `endedAt` and the finalization state.
    expect(prisma.callUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { rawConnectedSeconds: 0 } }),
    );
  });

  it('does not compensate a connected call that reports a zero duration', async () => {
    const { service, admission } = makeService({
      usageConnectedAt: new Date('2026-06-07T10:00:00.000Z'),
    });

    await expect(
      service.handleEvent({
        type: 'call_ended',
        eventId: 'evt-3',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:00.000Z',
        durationSeconds: 0,
      }),
    ).resolves.toMatchObject({ allowed: true });

    // The first minute was committed at connect; a short call is still billed
    // for it and must not be refunded.
    expect(admission.compensate).not.toHaveBeenCalled();
    expect(admission.releaseLease).toHaveBeenCalledWith('org-1', 'call-1');
  });

  it('falls back to finalizing when no usage row is found for the ended call', async () => {
    const { service, prisma, admission } = makeService({ usageMissing: true });

    await expect(
      service.handleEvent({
        type: 'call_ended',
        eventId: 'evt-3',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:05:00.000Z',
        durationSeconds: 305,
      }),
    ).resolves.toMatchObject({ allowed: true });

    // With no row there is no reservation state to reason about, so the
    // idempotent finalize runs and the lease is still freed.
    expect(admission.compensate).not.toHaveBeenCalled();
    expect(prisma.callUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ finalizationState: 'finalized' }),
      }),
    );
    expect(admission.releaseLease).toHaveBeenCalledWith('org-1', 'call-1');
  });

  it('refunds the reserved minute when the call never connected', async () => {
    const { service, admission } = makeService();

    await expect(
      service.handleEvent({
        type: 'call_failed',
        eventId: 'evt-4',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:05.000Z',
        failureCode: 'no_answer',
      }),
    ).resolves.toMatchObject({ allowed: true });

    expect(admission.compensate).toHaveBeenCalledWith('org-1', 'call-1', 'failed:no_answer');
  });

  it('bills a minute once when the same event is delivered twice concurrently', async () => {
    const { service, prisma, creditLedger } = makeService();
    const event = {
      type: 'minute_boundary' as const,
      eventId: 'evt-2',
      callId: 'call-1',
      organizationId: 'org-1',
      occurredAt: '2026-06-07T10:01:00.000Z',
      minute: 2,
    };

    // Both deliveries are in flight before either finishes, which is exactly
    // the interleaving that used to let two callers each debit a minute.
    const [first, second] = await Promise.all([
      service.handleEvent(event),
      service.handleEvent(event),
    ]);

    // One debit, one usage increment, and both callers see the same answer.
    expect(creditLedger.reserveAndDebitNextMinute).toHaveBeenCalledTimes(1);
    expect(prisma.callUsage.updateMany).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ allowed: true });
  });

  describe('low-balance warning', () => {
    /** 2 of the free plan's 10 minutes: exactly the 20% threshold. */
    const LOW_BALANCE = {
      organizationId: 'org-1',
      includedMinutesRemaining: 2,
      purchasedMinutesRemaining: 0,
    };

    it('enqueues the warning under a month-keyed dedup id when an allowed decision is at the threshold', async () => {
      const { service, queues } = makeService({ balance: LOW_BALANCE });

      await expect(
        service.handleEvent({
          type: 'call_connected',
          eventId: 'evt-1',
          callId: 'call-1',
          organizationId: 'org-1',
          occurredAt: '2026-06-07T10:00:00.000Z',
          providerCallId: 'pc-1',
        }),
      ).resolves.toMatchObject({ allowed: true });

      expect(queues.enqueue).toHaveBeenCalledWith(
        LOW_BALANCE_QUEUE,
        LOW_BALANCE_CHECK_JOB,
        { organizationId: 'org-1' },
        expect.objectContaining({
          // The month-keyed id is the once-per-month guarantee.
          jobId: `low-balance:org-1:${currentMonthKey()}`,
        }),
      );
    });

    it('enqueues when a debited minute leaves the balance at the threshold', async () => {
      const { service, queues } = makeService({ balance: LOW_BALANCE });

      await expect(
        service.handleEvent({
          type: 'minute_boundary',
          eventId: 'evt-2',
          callId: 'call-1',
          organizationId: 'org-1',
          occurredAt: '2026-06-07T10:01:00.000Z',
          minute: 2,
        }),
      ).resolves.toMatchObject({ allowed: true });

      expect(queues.enqueue).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue for a healthy balance', async () => {
      const { service, queues } = makeService();

      await expect(
        service.handleEvent({
          type: 'call_connected',
          eventId: 'evt-1',
          callId: 'call-1',
          organizationId: 'org-1',
          occurredAt: '2026-06-07T10:00:00.000Z',
          providerCallId: 'pc-1',
        }),
      ).resolves.toMatchObject({ allowed: true });

      expect(queues.enqueue).not.toHaveBeenCalled();
    });

    it('never fails metering when the enqueue itself fails', async () => {
      const { service, queues } = makeService({ balance: LOW_BALANCE, enqueueThrows: true });

      await expect(
        service.handleEvent({
          type: 'call_connected',
          eventId: 'evt-1',
          callId: 'call-1',
          organizationId: 'org-1',
          occurredAt: '2026-06-07T10:00:00.000Z',
          providerCallId: 'pc-1',
        }),
      ).resolves.toMatchObject({ allowed: true, reason: 'allowed' });

      expect(queues.enqueue).toHaveBeenCalled();
    });
  });
});
