import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';

const startedAt = new Date('2026-08-29T10:00:00.000Z');

/**
 * A call row as `end()` reads it. `status`/`durationSeconds` are the two fields
 * the terminal guard exists to protect.
 */
function callRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'call-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    agentVersionId: 'version-1',
    direction: 'outbound',
    status: 'in_progress',
    provider: 'openai-realtime',
    pipeline: 'realtime',
    providerCallId: 'provider-call-1',
    fromNumber: null,
    toNumber: '+15551234567',
    contactName: null,
    durationSeconds: null,
    outcome: null,
    startedAt,
    endedAt: null,
    createdAt: startedAt,
    ...overrides,
  };
}

function makeService(row: Record<string, unknown>) {
  const prisma = {
    call: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
  };
  const audit = { log: vi.fn(async () => undefined) };
  const voice = { name: 'openai-realtime', endCall: vi.fn(async () => undefined) };
  const analytics = { recordEventInternal: vi.fn(async () => undefined) };
  const billing = { recordUsage: vi.fn(async () => undefined) };
  const queue = { enqueue: vi.fn(async () => undefined) };
  const cache = { del: vi.fn(async () => undefined) };
  const service = new CallsService(
    prisma as never,
    audit as never,
    voice as never,
    {} as never,
    {} as never,
    analytics as never,
    billing as never,
    queue as never,
    {} as never,
    cache as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, voice, audit, analytics, billing, queue };
}

describe('CallsService.end terminal-state guard', () => {
  it('ends a live call, stamping the duration from startedAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T10:00:30.000Z'));
    try {
      const { service, prisma, voice } = makeService(callRow());

      const result = await service.end('ws-1', 'call-1', 'user-1');

      expect(voice.endCall).toHaveBeenCalledTimes(1);
      expect(prisma.call.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'call-1' },
          data: expect.objectContaining({ status: 'completed', durationSeconds: 30 }),
        }),
      );
      expect(result.duration_seconds).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The route is a plain POST open to editors, so a retry or a double-click
   * calls this twice. Without the guard the second call re-derives the duration
   * as `now - startedAt` — an hour after the fact, an hour of billable minutes —
   * and records the usage a second time.
   */
  it('does not re-stamp duration or re-record usage when the call already completed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T11:00:00.000Z'));
    try {
      const { service, prisma, voice, audit, analytics, billing, queue } = makeService(
        callRow({
          status: 'completed',
          durationSeconds: 30,
          endedAt: new Date('2026-08-29T10:00:30.000Z'),
          outcome: 'test_completed',
        }),
      );

      const result = await service.end('ws-1', 'call-1', 'user-1');

      expect(prisma.call.update).not.toHaveBeenCalled();
      expect(billing.recordUsage).not.toHaveBeenCalled();
      expect(voice.endCall).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(analytics.recordEventInternal).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
      // The existing summary is returned, so the client still sees the true
      // final state rather than an error.
      expect(result.status).toBe('completed');
      expect(result.duration_seconds).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not launder a failed call into completed', async () => {
    const { service, prisma } = makeService(
      callRow({ status: 'failed', outcome: 'provider_dispatch_failed', durationSeconds: null }),
    );

    const result = await service.end('ws-1', 'call-1', 'user-1');

    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.outcome).toBe('provider_dispatch_failed');
  });
});
