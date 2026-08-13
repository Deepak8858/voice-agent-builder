import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type Job } from 'bullmq';
import {
  DigestWorker,
  DIGEST_FANOUT_JOB,
  DIGEST_SCHEDULER_KEY,
  DIGEST_WORKSPACE_JOB,
  currentWeekKey,
} from './digest.worker';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const envMock = vi.hoisted(() => ({
  env: {
    RESEND_API_KEY: 'test-resend-key' as string | undefined,
    WEEKLY_DIGEST_CRON: '0 9 * * 1',
    WEEKLY_DIGEST_TIMEZONE: 'UTC',
  },
}));

vi.mock('../config/env', () => ({
  env: envMock.env,
  isProduction: () => false,
}));

const mockQueueHandle = {
  upsertJobScheduler: vi.fn(),
  addBulk: vi.fn(),
};

const mockQueueService = {
  getConnection: vi.fn().mockReturnValue({}),
  getBullMqConnection: vi.fn().mockReturnValue({}),
  queue: vi.fn(() => mockQueueHandle),
};

const mockPrisma = {
  workspace: {
    findMany: vi.fn(),
  },
};

const mockEmail = {
  sendWeeklyDigest: vi.fn(),
};

function build(): DigestWorker {
  return new DigestWorker(mockQueueService as never, mockPrisma as never, mockEmail as never);
}

function fanoutJob(): Job<{ workspaceId?: string }> {
  return { name: DIGEST_FANOUT_JOB, data: {} } as Job<{ workspaceId?: string }>;
}

describe('DigestWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env.RESEND_API_KEY = 'test-resend-key';
    mockEmail.sendWeeklyDigest.mockResolvedValue({ status: 'sent', sent: 1, failed: 0 });
    mockQueueHandle.upsertJobScheduler.mockResolvedValue(undefined);
    mockQueueHandle.addBulk.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The regression this whole worker exists to prevent: sendWeeklyDigest was
   * implemented and tested but never registered anywhere, so it never ran in
   * production. If the scheduler registration is dropped, this fails.
   */
  describe('registerSchedule', () => {
    it('registers a repeatable scheduler on module init', async () => {
      const worker = build();
      await worker.onModuleInit();

      expect(mockQueueHandle.upsertJobScheduler).toHaveBeenCalledTimes(1);
      const [key, repeat, template] = mockQueueHandle.upsertJobScheduler.mock.calls[0]!;
      expect(key).toBe(DIGEST_SCHEDULER_KEY);
      expect(repeat).toMatchObject({ pattern: '0 9 * * 1', tz: 'UTC' });
      expect(template).toMatchObject({ name: DIGEST_FANOUT_JOB });
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

      const worker = build();
      const pending = worker.registerSchedule();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();

      // Retried rather than failing on the first attempt.
      expect(mockQueueHandle.upsertJobScheduler.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('fan-out', () => {
    it('enqueues one job per active workspace', async () => {
      mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: 'ws-1' }, { id: 'ws-2' }]);

      await build().processor(fanoutJob());

      expect(mockQueueHandle.addBulk).toHaveBeenCalledTimes(1);
      const bulk = mockQueueHandle.addBulk.mock.calls[0]![0] as Array<{
        name: string;
        data: { workspaceId: string };
      }>;
      expect(bulk).toHaveLength(2);
      expect(bulk.map((entry) => entry.data.workspaceId)).toEqual(['ws-1', 'ws-2']);
      expect(bulk.every((entry) => entry.name === DIGEST_WORKSPACE_JOB)).toBe(true);
    });

    it('only selects active workspaces', async () => {
      mockPrisma.workspace.findMany.mockResolvedValueOnce([]);

      await build().processor(fanoutJob());

      expect(mockPrisma.workspace.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'active' } }),
      );
    });

    it('does not deliver inline, so one tenant cannot abort the run', async () => {
      mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: 'ws-1' }]);

      await build().processor(fanoutJob());

      expect(mockEmail.sendWeeklyDigest).not.toHaveBeenCalled();
    });

    it('pages through workspaces with a cursor instead of loading them all at once', async () => {
      const firstPage = Array.from({ length: 200 }, (_, i) => ({ id: `ws-${String(i).padStart(3, '0')}` }));
      mockPrisma.workspace.findMany
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([{ id: 'ws-200' }]);

      await build().processor(fanoutJob());

      expect(mockPrisma.workspace.findMany).toHaveBeenCalledTimes(2);
      const secondCall = mockPrisma.workspace.findMany.mock.calls[1]![0];
      expect(secondCall).toMatchObject({ skip: 1, cursor: { id: 'ws-199' } });
      expect(mockQueueHandle.addBulk).toHaveBeenCalledTimes(2);
    });

    it('assigns per-week job ids so a replayed fan-out cannot double-send', async () => {
      mockPrisma.workspace.findMany.mockResolvedValueOnce([{ id: 'ws-1' }]);

      await build().processor(fanoutJob());

      const bulk = mockQueueHandle.addBulk.mock.calls[0]![0] as Array<{ opts: { jobId: string } }>;
      expect(bulk[0]!.opts.jobId).toBe(`${DIGEST_SCHEDULER_KEY}:ws-1:${currentWeekKey()}`);
    });

    it('skips the whole run when email is not configured', async () => {
      envMock.env.RESEND_API_KEY = undefined;

      await build().processor(fanoutJob());

      expect(mockPrisma.workspace.findMany).not.toHaveBeenCalled();
      expect(mockQueueHandle.addBulk).not.toHaveBeenCalled();
    });
  });

  describe('per-workspace delivery', () => {
    it('sends the digest for the job workspace', async () => {
      const job = {
        name: DIGEST_WORKSPACE_JOB,
        data: { workspaceId: 'ws-1' },
      } as Job<{ workspaceId?: string }>;

      await build().processor(job);

      expect(mockEmail.sendWeeklyDigest).toHaveBeenCalledWith('ws-1');
    });

    it('throws on a malformed job so BullMQ retries rather than silently no-oping', async () => {
      const job = { name: DIGEST_WORKSPACE_JOB, data: {} } as Job<{ workspaceId?: string }>;

      await expect(build().processor(job)).rejects.toThrow('missing workspaceId');
      expect(mockEmail.sendWeeklyDigest).not.toHaveBeenCalled();
    });

    it('propagates delivery failures so the job is retried', async () => {
      mockEmail.sendWeeklyDigest.mockRejectedValueOnce(new Error('resend down'));
      const job = {
        name: DIGEST_WORKSPACE_JOB,
        data: { workspaceId: 'ws-1' },
      } as Job<{ workspaceId?: string }>;

      await expect(build().processor(job)).rejects.toThrow('resend down');
    });

    it('treats a skipped workspace as success, not a retryable failure', async () => {
      mockEmail.sendWeeklyDigest.mockResolvedValueOnce({
        status: 'skipped',
        reason: 'no_recipients',
        sent: 0,
        failed: 0,
      });
      const job = {
        name: DIGEST_WORKSPACE_JOB,
        data: { workspaceId: 'ws-1' },
      } as Job<{ workspaceId?: string }>;

      await expect(build().processor(job)).resolves.toBeUndefined();
    });
  });
});

describe('currentWeekKey', () => {
  it('is stable across days within the same ISO week', () => {
    // 2026-08-03 is a Monday; 2026-08-09 the following Sunday.
    expect(currentWeekKey(new Date('2026-08-03T00:00:00Z')))
      .toBe(currentWeekKey(new Date('2026-08-09T23:59:59Z')));
  });

  it('changes between adjacent weeks', () => {
    expect(currentWeekKey(new Date('2026-08-03T00:00:00Z')))
      .not.toBe(currentWeekKey(new Date('2026-08-10T00:00:00Z')));
  });
});
