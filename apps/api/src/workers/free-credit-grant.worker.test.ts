import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type Job } from 'bullmq';
import {
  FreeCreditGrantWorker,
  FREE_CREDIT_GRANT_ORG_JOB,
  FREE_CREDIT_GRANT_SCHEDULER_KEY,
  FREE_CREDIT_GRANT_SWEEP_JOB,
  type FreeCreditGrantJob,
} from './free-credit-grant.worker';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const envMock = vi.hoisted(() => ({
  env: {
    FREE_CREDIT_GRANT_CRON: '15 0 * * *',
  },
}));

vi.mock('../config/env', () => ({
  env: envMock.env,
  isProduction: () => false,
}));

const mockQueueHandle = {
  upsertJobScheduler: vi.fn(),
  addBulk: vi.fn(),
  add: vi.fn(),
};

const mockQueueService = {
  getConnection: vi.fn().mockReturnValue({}),
  getBullMqConnection: vi.fn().mockReturnValue({}),
  queue: vi.fn(() => mockQueueHandle),
};

const mockPrisma = {
  organization: {
    findMany: vi.fn(),
  },
};

const mockCreditLedger = {
  grantFreeMonthlyCredits: vi.fn(),
};

const mockEntitlements = {
  getEffectivePlan: vi.fn(),
};

/** UTC instant used for every test, so the derived month key is deterministic. */
const NOW = new Date('2026-08-23T14:00:00.000Z');
const MONTH_KEY = '2026-08';

function build(): FreeCreditGrantWorker {
  return new FreeCreditGrantWorker(
    mockQueueService as never,
    mockPrisma as never,
    mockCreditLedger as never,
    mockEntitlements as never,
  );
}

function sweepJob(data: FreeCreditGrantJob = {}): Job<FreeCreditGrantJob> {
  return { name: FREE_CREDIT_GRANT_SWEEP_JOB, data } as Job<FreeCreditGrantJob>;
}

function grantJob(data: FreeCreditGrantJob): Job<FreeCreditGrantJob> {
  return { name: FREE_CREDIT_GRANT_ORG_JOB, data } as Job<FreeCreditGrantJob>;
}

function effectivePlan(overrides: {
  plan?: string;
  status?: string;
  paidAccess?: boolean;
  includedMinutes?: number;
}) {
  return {
    organizationId: 'org-1',
    plan: overrides.plan ?? 'free',
    status: overrides.status ?? 'none',
    catalogVersion: '2026-08-23',
    paidAccess: overrides.paidAccess ?? false,
    entitlements: { includedMinutes: overrides.includedMinutes ?? 10 },
  };
}

describe('FreeCreditGrantWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockQueueHandle.upsertJobScheduler.mockResolvedValue(undefined);
    mockQueueHandle.addBulk.mockResolvedValue([]);
    mockQueueHandle.add.mockResolvedValue({});
    mockPrisma.organization.findMany.mockResolvedValue([]);
    mockEntitlements.getEffectivePlan.mockResolvedValue(effectivePlan({}));
    mockCreditLedger.grantFreeMonthlyCredits.mockResolvedValue({ availableSeconds: 600 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerSchedule', () => {
    it('registers a repeatable UTC scheduler on module init', async () => {
      await build().registerSchedule();

      expect(mockQueueHandle.upsertJobScheduler).toHaveBeenCalledTimes(1);
      const [key, repeat, template] = mockQueueHandle.upsertJobScheduler.mock.calls[0]!;
      expect(key).toBe(FREE_CREDIT_GRANT_SCHEDULER_KEY);
      // UTC is not incidental: the grant key is a UTC month, so a schedule in
      // another timezone would fire on a day belonging to a different key.
      expect(repeat).toMatchObject({ pattern: '15 0 * * *', tz: 'UTC' });
      expect(template).toMatchObject({ name: FREE_CREDIT_GRANT_SWEEP_JOB });
    });

    it('uses a stable key so repeated boots do not stack duplicate schedules', async () => {
      await build().registerSchedule();
      await build().registerSchedule();

      const keys = mockQueueHandle.upsertJobScheduler.mock.calls.map((call) => call[0]);
      expect(new Set(keys).size).toBe(1);
    });

    it('retries and finally gives up without crashing boot when Redis is unavailable', async () => {
      mockQueueHandle.upsertJobScheduler.mockRejectedValue(new Error('ECONNREFUSED'));

      const pending = build().registerSchedule();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();

      expect(mockQueueHandle.upsertJobScheduler.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('boot catch-up sweep', () => {
    /**
     * A deploy that spans the month boundary would otherwise leave every free
     * organization without minutes until the next scheduled run.
     */
    it('enqueues one sweep for the current month with a month-scoped job id', async () => {
      await build().enqueueBootSweep();

      expect(mockQueueHandle.add).toHaveBeenCalledTimes(1);
      const [name, data, opts] = mockQueueHandle.add.mock.calls[0]!;
      expect(name).toBe(FREE_CREDIT_GRANT_SWEEP_JOB);
      expect(data).toEqual({ monthKey: MONTH_KEY });
      expect(opts).toMatchObject({
        jobId: `${FREE_CREDIT_GRANT_SCHEDULER_KEY}:boot:${MONTH_KEY}`,
      });
    });

    it('does not fail boot when the sweep cannot be enqueued', async () => {
      mockQueueHandle.add.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(build().enqueueBootSweep()).resolves.toBeUndefined();
    });
  });

  describe('sweep', () => {
    it('fans out one grant job per active organization stamped with the month', async () => {
      mockPrisma.organization.findMany.mockResolvedValueOnce([{ id: 'org-1' }, { id: 'org-2' }]);

      await build().processor(sweepJob({ monthKey: MONTH_KEY }));

      const bulk = mockQueueHandle.addBulk.mock.calls[0]![0] as Array<{
        name: string;
        data: FreeCreditGrantJob;
        opts: { jobId: string };
      }>;
      expect(bulk).toHaveLength(2);
      expect(bulk.every((entry) => entry.name === FREE_CREDIT_GRANT_ORG_JOB)).toBe(true);
      expect(bulk.map((entry) => entry.data)).toEqual([
        { organizationId: 'org-1', monthKey: MONTH_KEY },
        { organizationId: 'org-2', monthKey: MONTH_KEY },
      ]);
      expect(bulk[0]!.opts.jobId).toBe(
        `${FREE_CREDIT_GRANT_SCHEDULER_KEY}:org-1:${MONTH_KEY}`,
      );
    });

    it('derives the month from the clock when the schedule supplies none', async () => {
      mockPrisma.organization.findMany.mockResolvedValueOnce([{ id: 'org-1' }]);

      await build().processor(sweepJob());

      const bulk = mockQueueHandle.addBulk.mock.calls[0]![0] as Array<{
        data: FreeCreditGrantJob;
      }>;
      expect(bulk[0]!.data.monthKey).toBe(MONTH_KEY);
    });

    it('only selects active organizations', async () => {
      await build().processor(sweepJob({ monthKey: MONTH_KEY }));

      expect(mockPrisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'active' } }),
      );
    });

    it('does not grant inline, so one tenant cannot abort the run', async () => {
      mockPrisma.organization.findMany.mockResolvedValueOnce([{ id: 'org-1' }]);

      await build().processor(sweepJob({ monthKey: MONTH_KEY }));

      expect(mockCreditLedger.grantFreeMonthlyCredits).not.toHaveBeenCalled();
    });

    it('pages with a cursor instead of loading every organization at once', async () => {
      const firstPage = Array.from({ length: 200 }, (_, i) => ({
        id: `org-${String(i).padStart(3, '0')}`,
      }));
      mockPrisma.organization.findMany
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([{ id: 'org-200' }]);

      await build().processor(sweepJob({ monthKey: MONTH_KEY }));

      expect(mockPrisma.organization.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.organization.findMany.mock.calls[1]![0]).toMatchObject({
        skip: 1,
        cursor: { id: 'org-199' },
      });
      expect(mockQueueHandle.addBulk).toHaveBeenCalledTimes(2);
    });
  });

  describe('per-organization grant', () => {
    it('grants the month the job carries, not the current month', async () => {
      await build().processor(grantJob({ organizationId: 'org-1', monthKey: '2026-07' }));

      // A job that waited in the queue across the boundary must still grant the
      // month it was enqueued for, or a retry would grant the wrong month.
      expect(mockCreditLedger.grantFreeMonthlyCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        monthKey: '2026-07',
      });
    });

    it('skips organizations with paid access so they are not granted twice', async () => {
      mockEntitlements.getEffectivePlan.mockResolvedValueOnce(
        effectivePlan({ plan: 'growth', status: 'active', paidAccess: true, includedMinutes: 2000 }),
      );

      await build().processor(grantJob({ organizationId: 'org-1', monthKey: MONTH_KEY }));

      expect(mockCreditLedger.grantFreeMonthlyCredits).not.toHaveBeenCalled();
    });

    /**
     * A corrupt subscription row resolves to `unknown`. Granting there would
     * hand credit to an organization whose commercial state cannot be read.
     */
    it('skips an organization whose subscription state is unreadable', async () => {
      mockEntitlements.getEffectivePlan.mockResolvedValueOnce(
        effectivePlan({ status: 'unknown' }),
      );

      await build().processor(grantJob({ organizationId: 'org-1', monthKey: MONTH_KEY }));

      expect(mockCreditLedger.grantFreeMonthlyCredits).not.toHaveBeenCalled();
    });

    it('skips a plan that includes no monthly minutes', async () => {
      mockEntitlements.getEffectivePlan.mockResolvedValueOnce(
        effectivePlan({ includedMinutes: 0 }),
      );

      await build().processor(grantJob({ organizationId: 'org-1', monthKey: MONTH_KEY }));

      expect(mockCreditLedger.grantFreeMonthlyCredits).not.toHaveBeenCalled();
    });

    /**
     * A paid plan whose payment lapsed falls back to free entitlements, so it
     * does receive the free allowance — it is a free organization now.
     */
    it('grants an unfunded paid plan that has fallen back to free', async () => {
      mockEntitlements.getEffectivePlan.mockResolvedValueOnce(
        effectivePlan({ status: 'past_due', paidAccess: false }),
      );

      await build().processor(grantJob({ organizationId: 'org-1', monthKey: MONTH_KEY }));

      expect(mockCreditLedger.grantFreeMonthlyCredits).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['organizationId', { monthKey: MONTH_KEY }],
      ['monthKey', { organizationId: 'org-1' }],
    ])('throws on a job missing %s so BullMQ retries rather than silently no-oping', async (
      _label,
      data,
    ) => {
      await expect(build().processor(grantJob(data))).rejects.toThrow();
      expect(mockCreditLedger.grantFreeMonthlyCredits).not.toHaveBeenCalled();
    });

    it('propagates grant failures so the job is retried', async () => {
      mockCreditLedger.grantFreeMonthlyCredits.mockRejectedValueOnce(new Error('db down'));

      await expect(
        build().processor(grantJob({ organizationId: 'org-1', monthKey: MONTH_KEY })),
      ).rejects.toThrow('db down');
    });

    /**
     * The ledger is the idempotency boundary. Re-running the same job must reach
     * it with an identical key so the second call is a replay, not a new grant.
     */
    it('replays with an identical key when the same job runs twice', async () => {
      const worker = build();
      const job = grantJob({ organizationId: 'org-1', monthKey: MONTH_KEY });

      await worker.processor(job);
      await worker.processor(job);

      expect(mockCreditLedger.grantFreeMonthlyCredits).toHaveBeenCalledTimes(2);
      expect(mockCreditLedger.grantFreeMonthlyCredits.mock.calls[0]).toEqual(
        mockCreditLedger.grantFreeMonthlyCredits.mock.calls[1],
      );
    });
  });
});
