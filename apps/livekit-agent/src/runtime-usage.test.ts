import { describe, expect, it, vi } from 'vitest';
import type { RuntimeUsageDecision } from '@voiceforge/shared';
import { CallMeter, createRuntimeUsageClient, runWithMeteredCall } from './runtime-usage';

const BALANCE = {
  organizationId: 'org-1',
  includedMinutesRemaining: 5,
  purchasedMinutesRemaining: 0,
};

function decision(overrides: Partial<RuntimeUsageDecision> = {}): RuntimeUsageDecision {
  return {
    eventId: 'evt-1',
    callId: 'call-1',
    organizationId: 'org-1',
    allowed: true,
    reason: 'allowed',
    billableMinutes: 1,
    creditBalance: BALANCE,
    ...overrides,
  };
}

function envelope(body: RuntimeUsageDecision, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data: body, error: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createRuntimeUsageClient', () => {
  it('posts to the internal usage endpoint with the internal key', async () => {
    const fetchImpl = vi.fn(async () => envelope(decision()));
    const emit = createRuntimeUsageClient({
      apiBaseUrl: 'http://api:4000/',
      internalApiKey: 'internal-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      emit({
        type: 'call_connected',
        eventId: 'call-1:connected',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:00:00.000Z',
        providerCallId: 'pc-1',
      }),
    ).resolves.toMatchObject({ allowed: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api:4000/api/v1/internal/runtime/usage/events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-key': 'internal-key' }),
      }),
    );
  });

  it('retries a transient failure with the same event id so the API replays instead of double-charging', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(envelope(decision()));
    const emit = createRuntimeUsageClient({
      apiBaseUrl: 'http://api:4000',
      internalApiKey: 'internal-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    await emit({
      type: 'minute_boundary',
      eventId: 'call-1:minute:2',
      callId: 'call-1',
      organizationId: 'org-1',
      occurredAt: '2026-06-07T10:01:00.000Z',
      minute: 2,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(new Set(bodies.map((body) => body.eventId))).toEqual(new Set(['call-1:minute:2']));
  });

  it('throws after exhausting attempts rather than reporting an allowed call', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const emit = createRuntimeUsageClient({
      apiBaseUrl: 'http://api:4000',
      internalApiKey: 'internal-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 2,
      sleep: async () => undefined,
    });

    await expect(
      emit({
        type: 'call_ended',
        eventId: 'call-1:ended',
        callId: 'call-1',
        organizationId: 'org-1',
        occurredAt: '2026-06-07T10:05:00.000Z',
        durationSeconds: 300,
      }),
    ).rejects.toThrow('503');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function makeMeter(overrides: {
  emit?: ReturnType<typeof vi.fn>;
  maxConsecutiveFailures?: number;
  maxDurationSeconds?: number;
  minuteIntervalMs?: number;
  now?: () => Date;
} = {}) {
  const emit = overrides.emit ?? vi.fn(async () => decision());
  const terminate = vi.fn(async () => undefined);
  const meter = new CallMeter({
    callId: 'call-1',
    organizationId: 'org-1',
    emit: emit as never,
    terminate,
    maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? 2,
    ...(overrides.maxDurationSeconds !== undefined
      ? { maxDurationSeconds: overrides.maxDurationSeconds }
      : {}),
    ...(overrides.minuteIntervalMs !== undefined
      ? { minuteIntervalMs: overrides.minuteIntervalMs }
      : {}),
    now: overrides.now ?? (() => new Date('2026-06-07T10:00:00.000Z')),
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  });
  return { meter, emit, terminate };
}

describe('CallMeter', () => {
  it('reports the connection with a deterministic event id', async () => {
    const { meter, emit, terminate } = makeMeter();

    await meter.connected('pc-1');

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'call_connected',
        eventId: 'call-1:connected',
        callId: 'call-1',
        organizationId: 'org-1',
        providerCallId: 'pc-1',
      }),
    );
    expect(terminate).not.toHaveBeenCalled();
  });

  it('hangs up when the connection cannot be billed', async () => {
    const emit = vi.fn(async () => decision({ allowed: false, reason: 'credit_insufficient' }));
    const { meter, terminate } = makeMeter({ emit });

    await meter.connected('pc-1');

    expect(terminate).toHaveBeenCalledWith('credit_insufficient');
    expect(meter.isSettled).toBe(true);
  });

  it('retries a transient connection decision before allowing the call', async () => {
    const emit = vi
      .fn()
      .mockResolvedValueOnce(decision({
        allowed: false,
        reason: 'billing_temporarily_unavailable',
        billableMinutes: 0,
      }))
      .mockResolvedValueOnce(decision());
    const { meter, terminate } = makeMeter({ emit, maxConsecutiveFailures: 2 });

    await meter.connected('pc-1');

    expect(emit).toHaveBeenCalledTimes(2);
    expect(terminate).not.toHaveBeenCalled();
    expect(meter.isSettled).toBe(false);
  });

  it('fails closed when the connection remains retryable', async () => {
    const emit = vi.fn(async () => decision({
      allowed: false,
      reason: 'billing_temporarily_unavailable',
      billableMinutes: 0,
    }));
    const { meter, terminate } = makeMeter({ emit, maxConsecutiveFailures: 2 });

    await meter.connected('pc-1');

    expect(emit).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledWith('metering_unavailable');
    expect(meter.isSettled).toBe(true);
  });

  it('numbers minute boundaries sequentially from the second minute', async () => {
    const { meter, emit } = makeMeter();

    await meter.reportMinuteBoundary();
    await meter.reportMinuteBoundary();

    expect(emit.mock.calls.map((call) => (call[0] as { eventId: string }).eventId)).toEqual([
      'call-1:minute:2',
      'call-1:minute:3',
    ]);
  });

  it('bounds retryable minute decisions before failing closed', async () => {
    const emit = vi.fn(async () => decision({
      allowed: false,
      reason: 'billing_temporarily_unavailable',
      billableMinutes: 0,
    }));
    const { meter, terminate } = makeMeter({ emit, maxConsecutiveFailures: 2 });

    await meter.reportMinuteBoundary();
    expect(terminate).not.toHaveBeenCalled();

    await meter.reportMinuteBoundary();
    expect(terminate).toHaveBeenCalledWith('metering_unavailable');
  });

  /** The enforcement this whole path exists for. */
  it('hangs up when a minute boundary is refused', async () => {
    const emit = vi.fn(async () => decision({ allowed: false, reason: 'credit_insufficient' }));
    const { meter, terminate } = makeMeter({ emit });

    await meter.reportMinuteBoundary();

    expect(terminate).toHaveBeenCalledWith('credit_insufficient');
  });

  it('tolerates a single unreported minute but hangs up when metering stays unreachable', async () => {
    const emit = vi.fn(async () => {
      throw new Error('api down');
    });
    const { meter, terminate } = makeMeter({ emit, maxConsecutiveFailures: 2 });

    await meter.reportMinuteBoundary();
    expect(terminate).not.toHaveBeenCalled();

    await meter.reportMinuteBoundary();
    expect(terminate).toHaveBeenCalledWith('metering_unavailable');
  });

  it('retries the same boundary after an alternating failure instead of granting a free minute', async () => {
    const emit = vi
      .fn()
      .mockRejectedValueOnce(new Error('api down'))
      .mockResolvedValueOnce(decision());
    const { meter, terminate } = makeMeter({ emit, maxConsecutiveFailures: 2 });

    await meter.reportMinuteBoundary();
    await meter.reportMinuteBoundary();

    expect(emit.mock.calls.map((call) => (call[0] as { eventId: string }).eventId)).toEqual([
      'call-1:minute:2',
      'call-1:minute:2',
    ]);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('serializes concurrent boundary reports so one minute cannot be charged twice', async () => {
    let release!: (value: RuntimeUsageDecision) => void;
    const emit = vi.fn(() => new Promise<RuntimeUsageDecision>((resolve) => { release = resolve; }));
    const { meter } = makeMeter({ emit });

    const first = meter.reportMinuteBoundary();
    const second = meter.reportMinuteBoundary();
    expect(emit).toHaveBeenCalledTimes(1);

    release(decision());
    await Promise.all([first, second]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('hangs up at the funded deadline when a boundary request remains in flight', async () => {
    vi.useFakeTimers();
    try {
      const emit = vi
        .fn()
        .mockResolvedValueOnce(decision())
        .mockImplementationOnce(() => new Promise<RuntimeUsageDecision>(() => undefined));
      const { meter, terminate } = makeMeter({
        emit,
        minuteIntervalMs: 60_000,
        now: () => new Date(Date.now()),
      });
      await meter.connected('pc-1');
      meter.start();

      // The boundary fires at 60s reporting minute 2, whose funding runs out at
      // 120s. Termination must happen at that deadline, not at the boundary.
      await vi.advanceTimersByTimeAsync(119_999);
      expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(terminate).toHaveBeenCalledWith('metering_unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hang up when the first-boundary emit is delayed but confirmed within the reported minute', async () => {
    vi.useFakeTimers();
    try {
      const emit = vi
        .fn()
        .mockResolvedValueOnce(decision())
        .mockImplementationOnce(
          () =>
            new Promise<RuntimeUsageDecision>((resolve) => {
              setTimeout(() => resolve(decision()), 5_000);
            }),
        )
        .mockResolvedValue(decision());
      const { meter, terminate } = makeMeter({
        emit,
        minuteIntervalMs: 60_000,
        now: () => new Date(Date.now()),
      });
      await meter.connected('pc-1');
      meter.start();

      // The first boundary fires at exactly 60s. A slow-but-successful emit
      // must not be raced against a zero-width deadline computed from the
      // previous minute.
      await vi.advanceTimersByTimeAsync(65_000);
      expect(terminate).not.toHaveBeenCalled();
      expect(emit.mock.calls.map((call) => (call[0] as { eventId: string }).eventId)).toContain(
        'call-1:minute:2',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('hangs up at a configured hard duration cap', async () => {
    vi.useFakeTimers();
    try {
      const { meter, terminate } = makeMeter({ maxDurationSeconds: 90 });
      await meter.connected('pc-1');
      meter.start();

      await vi.advanceTimersByTimeAsync(89_999);
      expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(terminate).toHaveBeenCalledWith('max_duration_exceeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restart or emit an end after billing termination', async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn(async () => decision({ allowed: false, reason: 'credit_insufficient' }));
      const { meter } = makeMeter({ emit });

      await meter.connected('pc-1');
      meter.start();
      await vi.advanceTimersByTimeAsync(120_000);
      await meter.ended(30);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0]![0]).toMatchObject({ type: 'call_connected' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the end exactly once so a shutdown callback cannot double-settle', async () => {
    const { meter, emit } = makeMeter();

    await meter.connected('pc-1');
    await meter.ended(120);
    await meter.ended(120);

    const ends = emit.mock.calls.filter((call) => (call[0] as { type: string }).type === 'call_ended');
    expect(ends).toHaveLength(1);
    expect(ends[0]![0]).toMatchObject({ eventId: 'call-1:ended', durationSeconds: 120 });
  });

  it('reports a failure so the reservation and lease are released', async () => {
    const { meter, emit } = makeMeter();

    await meter.failed('runtime_error');

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'call_failed',
        eventId: 'call-1:failed',
        failureCode: 'runtime_error',
      }),
    );
  });

  it('does not report a failure after the call already ended', async () => {
    const { meter, emit } = makeMeter();

    await meter.connected('pc-1');
    await meter.ended(30);
    await meter.failed('runtime_error');

    expect(emit.mock.calls.filter((call) => (call[0] as { type: string }).type === 'call_failed')).toHaveLength(0);
  });

  it('reports call_ended after billing enforcement terminates a connected call', async () => {
    const emit = vi
      .fn()
      .mockResolvedValueOnce(decision())
      .mockResolvedValueOnce(decision({ allowed: false, reason: 'credit_insufficient' }))
      .mockResolvedValue(decision());
    const { meter } = makeMeter({ emit });

    await meter.connected('pc-1');
    await meter.reportMinuteBoundary();
    await meter.ended(61);

    expect(emit.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
      'call_connected',
      'minute_boundary',
      'call_ended',
    ]);
  });

  it('authorizes billing before starting the voice session', async () => {
    const order: string[] = [];
    const emit = vi.fn(async () => {
      order.push('connected');
      return decision();
    });
    const { meter } = makeMeter({ emit });
    const callbacks: Array<() => Promise<void>> = [];

    await runWithMeteredCall(
      meter,
      'pc-1',
      (callback) => callbacks.push(callback),
      async () => { order.push('session'); },
    );

    expect(order).toEqual(['connected', 'session']);
    expect(callbacks).toHaveLength(1);
  });

  it('never starts voice and reports call_failed when connection billing is refused', async () => {
    const emit = vi.fn(async () => decision({ allowed: false, reason: 'credit_insufficient' }));
    const { meter } = makeMeter({ emit });
    const callbacks: Array<() => Promise<void>> = [];
    const run = vi.fn(async () => undefined);

    await expect(runWithMeteredCall(meter, 'pc-1', (callback) => callbacks.push(callback), run))
      .resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    await callbacks[0]!();
    expect(emit.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
      'call_connected',
      'call_failed',
    ]);
  });
});
