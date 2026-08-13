import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeUsageService } from './runtime-usage.service';

const BALANCE = {
  organizationId: 'org-1',
  includedMinutesRemaining: 10,
  purchasedMinutesRemaining: 0,
  lifetimeBrowserTestSecondsRemaining: 0,
};

function makeService(overrides?: {
  call?: unknown;
  replayDecision?: unknown;
  commitThrows?: boolean;
  nextMinuteAllowed?: boolean;
}) {
  const prisma = {
    call: {
      findFirst: vi.fn(async () =>
        overrides?.call === undefined
          ? { id: 'call-1', workspaceId: 'ws-1', organizationId: 'org-1' }
          : overrides.call,
      ),
    },
    runtimeUsageEvent: {
      findUnique: vi.fn(async () =>
        overrides?.replayDecision ? { decision: overrides.replayDecision } : null,
      ),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    callUsage: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };

  const creditLedger = {
    commitReservation: vi.fn(async () => BALANCE),
    reserveAndDebitNextMinute: vi.fn(async () => ({
      eventId: 'evt-1',
      callId: 'call-1',
      organizationId: 'org-1',
      allowed: overrides?.nextMinuteAllowed ?? true,
      reason: (overrides?.nextMinuteAllowed ?? true) ? 'allowed' : 'credit_insufficient',
      billableMinutes: (overrides?.nextMinuteAllowed ?? true) ? 1 : 0,
      creditBalance: BALANCE,
    })),
    getBalance: vi.fn(async () => BALANCE),
  };
  if (overrides?.commitThrows) {
    creditLedger.commitReservation.mockRejectedValue(new Error('ledger unavailable'));
  }

  const admission = {
    compensate: vi.fn(async () => undefined),
    releaseLease: vi.fn(async () => undefined),
  };

  const service = new RuntimeUsageService(
    prisma as never,
    creditLedger as never,
    admission as never,
  );

  return { service, prisma, creditLedger, admission };
}

describe('RuntimeUsageService.handleEvent', () => {
  beforeEach(() => vi.clearAllMocks());

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

    expect(prisma.runtimeUsageEvent.upsert).not.toHaveBeenCalled();
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
    expect(prisma.runtimeUsageEvent.upsert).not.toHaveBeenCalled();
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
    expect(prisma.callUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ finalizationState: 'connected' }),
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
});
