import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type Job } from 'bullmq';
import {
  RetentionSweepWorker,
  RETENTION_SWEEP_JOB,
  RETENTION_SWEEP_SCHEDULER_KEY,
  type RetentionSweepJob,
} from './retention-sweep.worker';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const envMock = vi.hoisted(() => ({
  env: {
    RETENTION_SWEEP_ENABLED: false,
  },
}));

vi.mock('../config/env', () => ({
  env: envMock.env,
  isProduction: () => false,
}));

const mockQueueHandle = {
  upsertJobScheduler: vi.fn(),
};

const mockQueueService = {
  getConnection: vi.fn().mockReturnValue({}),
  getBullMqConnection: vi.fn().mockReturnValue({}),
  queue: vi.fn(() => mockQueueHandle),
};

const mockRetention = {
  sweepExpiredCalls: vi.fn(),
  sweepStaleTelephonyWebhookEvents: vi.fn(),
};

function build(): RetentionSweepWorker {
  return new RetentionSweepWorker(mockQueueService as never, mockRetention as never);
}

function sweepJob(): Job<RetentionSweepJob> {
  return { name: RETENTION_SWEEP_JOB, data: {} } as unknown as Job<RetentionSweepJob>;
}

describe('RetentionSweepWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env.RETENTION_SWEEP_ENABLED = false;
    mockQueueHandle.upsertJobScheduler.mockResolvedValue(undefined);
    mockRetention.sweepExpiredCalls.mockResolvedValue({ deleted: 0, remaining: 0 });
    mockRetention.sweepStaleTelephonyWebhookEvents.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registration is gated on RETENTION_SWEEP_ENABLED', () => {
    /**
     * The whole design of this track: the most destructive automation in the
     * product fails OFF. Nothing is scheduled by default, so a deploy that only
     * flips WORKERS_ENABLED cannot start deleting calls.
     */
    it('registers nothing while the flag is off (the default)', async () => {
      await build().onModuleInit();

      expect(mockQueueHandle.upsertJobScheduler).not.toHaveBeenCalled();
    });

    it('registers one repeatable daily job once the flag is on', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;

      await build().onModuleInit();

      expect(mockQueueHandle.upsertJobScheduler).toHaveBeenCalledTimes(1);
      const [key, repeat, template] = mockQueueHandle.upsertJobScheduler.mock.calls[0]!;
      expect(key).toBe(RETENTION_SWEEP_SCHEDULER_KEY);
      expect(repeat).toMatchObject({ pattern: '30 3 * * *', tz: 'UTC' });
      expect(template).toMatchObject({ name: RETENTION_SWEEP_JOB });
    });

    it('uses a stable key so repeated boots do not stack duplicate schedules', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;

      await build().onModuleInit();
      await build().onModuleInit();

      const keys = mockQueueHandle.upsertJobScheduler.mock.calls.map((call) => call[0]);
      expect(new Set(keys).size).toBe(1);
    });

    it('retries and finally gives up without crashing boot when Redis is unavailable', async () => {
      vi.useFakeTimers();
      envMock.env.RETENTION_SWEEP_ENABLED = true;
      mockQueueHandle.upsertJobScheduler.mockRejectedValue(new Error('ECONNREFUSED'));

      const worker = build();
      const pending = worker.registerSchedule();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();

      expect(mockQueueHandle.upsertJobScheduler.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('per-run re-check', () => {
    /**
     * BullMQ job schedulers live in Redis, so turning the flag off does not remove
     * an already-registered schedule and the job keeps arriving. Without this
     * branch, "off" would only mean "off for deployments that never had it on".
     */
    it('deletes nothing when the flag went off after the schedule was registered', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;
      const worker = build();
      await worker.onModuleInit();
      expect(mockQueueHandle.upsertJobScheduler).toHaveBeenCalledTimes(1);

      envMock.env.RETENTION_SWEEP_ENABLED = false;
      await worker.processor(sweepJob());

      expect(mockRetention.sweepExpiredCalls).not.toHaveBeenCalled();
      expect(mockRetention.sweepStaleTelephonyWebhookEvents).not.toHaveBeenCalled();
    });

    it('sweeps when the flag is on', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;

      await build().processor(sweepJob());

      expect(mockRetention.sweepExpiredCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe('the sweep call', () => {
    /**
     * Platform-wide, not per workspace: that is what a retention sweep is, and
     * RetentionService stamps 'all-workspaces' into the audit row for this shape.
     * A workspaceId slipping in here would silently leave every other tenant's
     * expired calls unenforced.
     */
    it('passes an empty scope, so the sweep is platform-wide', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;

      await build().processor(sweepJob());

      expect(mockRetention.sweepExpiredCalls).toHaveBeenCalledWith({});
    });

    /**
     * Five of the six webhook writers leave `call_id` NULL, so those payloads are
     * unreachable from the call sweep entirely. A run that finds no expired call
     * must still age them out, or a workspace on the 365-day default keeps raw
     * provider bodies for a year before the first call even expires.
     */
    it('ages out webhook payloads even on a run with no expired calls', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;
      mockRetention.sweepExpiredCalls.mockResolvedValueOnce({ deleted: 0, remaining: 0 });
      mockRetention.sweepStaleTelephonyWebhookEvents.mockResolvedValueOnce(41);
      const worker = build();
      const log = vi.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);

      await worker.processor(sweepJob());

      expect(mockRetention.sweepStaleTelephonyWebhookEvents).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('41'));
    });

    it('logs the result of a fully drained run', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;
      mockRetention.sweepExpiredCalls.mockResolvedValueOnce({ deleted: 12, remaining: 0 });
      const worker = build();
      const log = vi.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);

      await worker.processor(sweepJob());

      expect(log).toHaveBeenCalledWith(expect.stringContaining('12'));
    });

    /**
     * One batch per run is the deliberate ceiling, so a leftover backlog has to be
     * visible — otherwise a permanently under-drained sweep looks identical to a
     * healthy one.
     */
    it('warns about the leftover backlog instead of looping until drained', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;
      mockRetention.sweepExpiredCalls.mockResolvedValueOnce({ deleted: 5000, remaining: 731 });
      const worker = build();
      const warn = vi.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);

      await worker.processor(sweepJob());

      expect(mockRetention.sweepExpiredCalls).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('731'));
    });

    it('propagates a sweep failure so BullMQ retries it', async () => {
      envMock.env.RETENTION_SWEEP_ENABLED = true;
      mockRetention.sweepExpiredCalls.mockRejectedValueOnce(new Error('deadlock detected'));

      await expect(build().processor(sweepJob())).rejects.toThrow('deadlock detected');
    });
  });
});
