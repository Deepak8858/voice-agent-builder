import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Job } from 'bullmq';
import {
  CALL_LEASE_RENEWAL_JOB,
  CALL_LEASE_RENEWAL_SCHEDULER_KEY,
  CallLeaseRenewalWorker,
  leaseRenewalIntervalMs,
  type CallLeaseRenewalJob,
} from './call-lease-renewal.worker';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const envMock = vi.hoisted(() => ({
  env: {
    BILLING_LEASE_TTL_SECONDS: 90,
    BILLING_RECONCILIATION_BATCH_SIZE: 100,
  },
}));

vi.mock('../config/env', () => ({
  env: envMock.env,
  isProduction: () => false,
}));

const mockQueueHandle = { upsertJobScheduler: vi.fn() };
const mockQueueService = {
  getConnection: vi.fn().mockReturnValue({}),
  getBullMqConnection: vi.fn().mockReturnValue({}),
  queue: vi.fn(() => mockQueueHandle),
};
const mockConcurrency = {
  renewActiveLeases: vi.fn(async () => ({ checked: 0, renewed: 0, dropped: 0 })),
};

function build(): CallLeaseRenewalWorker {
  return new CallLeaseRenewalWorker(mockQueueService as never, mockConcurrency as never);
}

function job(data: CallLeaseRenewalJob = {}): Job<CallLeaseRenewalJob> {
  return { name: CALL_LEASE_RENEWAL_JOB, data } as Job<CallLeaseRenewalJob>;
}

describe('CallLeaseRenewalWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env.BILLING_LEASE_TTL_SECONDS = 90;
    mockQueueHandle.upsertJobScheduler.mockResolvedValue(undefined);
  });

  /**
   * A lease that is never renewed expires mid-call, so the sweep must run
   * several times within one TTL.
   */
  it('sweeps several times per lease TTL', () => {
    envMock.env.BILLING_LEASE_TTL_SECONDS = 90;
    expect(leaseRenewalIntervalMs()).toBe(30_000);
    envMock.env.BILLING_LEASE_TTL_SECONDS = 30;
    expect(leaseRenewalIntervalMs()).toBe(10_000);
  });

  it('registers a repeatable sweep on module init', async () => {
    await build().onModuleInit();

    expect(mockQueueHandle.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [key, repeat, template] = mockQueueHandle.upsertJobScheduler.mock.calls[0]!;
    expect(key).toBe(CALL_LEASE_RENEWAL_SCHEDULER_KEY);
    expect(repeat).toMatchObject({ every: 30_000 });
    expect(template).toMatchObject({ name: CALL_LEASE_RENEWAL_JOB });
  });

  it('uses a stable key so repeated boots do not stack duplicate schedules', async () => {
    await build().onModuleInit();
    await build().onModuleInit();

    const keys = mockQueueHandle.upsertJobScheduler.mock.calls.map((call) => call[0]);
    expect(new Set(keys).size).toBe(1);
  });

  it('retries and finally gives up without crashing boot when Redis is unavailable', async () => {
    vi.useFakeTimers();
    mockQueueHandle.upsertJobScheduler.mockRejectedValue(new Error('ECONNREFUSED'));

    const pending = build().registerSchedule();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();

    expect(mockQueueHandle.upsertJobScheduler.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });

  it('renews with the configured batch size', async () => {
    await build().processor(job());

    expect(mockConcurrency.renewActiveLeases).toHaveBeenCalledWith(100);
  });

  it('honours a per-run limit override', async () => {
    await build().processor(job({ limit: 5 }));

    expect(mockConcurrency.renewActiveLeases).toHaveBeenCalledWith(5);
  });

  it('propagates a sweep failure so BullMQ retries rather than silently skipping a TTL', async () => {
    mockConcurrency.renewActiveLeases.mockRejectedValueOnce(new Error('redis down'));

    await expect(build().processor(job())).rejects.toThrow('redis down');
  });

  it('rejects an unknown job name', async () => {
    const unknown = { name: 'billing.leases.unknown', data: {} } as Job<CallLeaseRenewalJob>;

    await expect(build().processor(unknown)).rejects.toThrow('Unknown call lease renewal job');
    expect(mockConcurrency.renewActiveLeases).not.toHaveBeenCalled();
  });
});
