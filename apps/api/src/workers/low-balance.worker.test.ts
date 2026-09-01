import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type Job } from 'bullmq';
import {
  LowBalanceWorker,
  LOW_BALANCE_CHECK_JOB,
  type LowBalanceJob,
} from './low-balance.worker';
import { currentMonthKey, freeMonthlyGrantKey } from '../billing/credit-ledger.service';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const mockQueueService = {
  getConnection: vi.fn().mockReturnValue({}),
  getBullMqConnection: vi.fn().mockReturnValue({}),
  queue: vi.fn(),
};

const mockPrisma = {
  billingCreditBucket: {
    findUnique: vi.fn(),
  },
  organization: {
    findUnique: vi.fn(),
  },
};

const mockEntitlements = {
  getEffectivePlan: vi.fn(),
};

const mockEmail = {
  sendLowBalanceWarning: vi.fn(),
};

function build(): LowBalanceWorker {
  return new LowBalanceWorker(
    mockQueueService as never,
    mockPrisma as never,
    mockEntitlements as never,
    mockEmail as never,
  );
}

function checkJob(data: LowBalanceJob): Job<LowBalanceJob> {
  return { name: LOW_BALANCE_CHECK_JOB, data } as Job<LowBalanceJob>;
}

function effectivePlan(overrides: { plan?: string; status?: string; paidAccess?: boolean }) {
  return {
    organizationId: 'org-1',
    plan: overrides.plan ?? 'free',
    status: overrides.status ?? 'none',
    catalogVersion: '2026-08-23',
    paidAccess: overrides.paidAccess ?? false,
    entitlements: { includedMinutes: 10 },
  };
}

describe('LowBalanceWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.getEffectivePlan.mockResolvedValue(effectivePlan({}));
    // 1 of 10 minutes left — at the 20% threshold.
    mockPrisma.billingCreditBucket.findUnique.mockResolvedValue({
      originalSeconds: 600,
      remainingSeconds: 60,
    });
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Acme',
      owner: { email: 'owner@example.com' },
    });
    mockEmail.sendLowBalanceWarning.mockResolvedValue(undefined);
  });

  it('warns the owner of a free organization below the threshold', async () => {
    await build().processor(checkJob({ organizationId: 'org-1' }));

    expect(mockPrisma.billingCreditBucket.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_sourceType_sourceId: {
          organizationId: 'org-1',
          sourceType: 'included',
          sourceId: freeMonthlyGrantKey('org-1', currentMonthKey()),
        },
      },
      select: { originalSeconds: true, remainingSeconds: true },
    });
    expect(mockEmail.sendLowBalanceWarning).toHaveBeenCalledWith({
      to: 'owner@example.com',
      organizationName: 'Acme',
      remainingMinutes: 1,
      includedMinutes: 10,
    });
  });

  it('skips a paid organization even though the hot path enqueued it', async () => {
    mockEntitlements.getEffectivePlan.mockResolvedValueOnce(
      effectivePlan({ plan: 'growth', status: 'active', paidAccess: true }),
    );

    await build().processor(checkJob({ organizationId: 'org-1' }));

    expect(mockPrisma.billingCreditBucket.findUnique).not.toHaveBeenCalled();
    expect(mockEmail.sendLowBalanceWarning).not.toHaveBeenCalled();
  });

  it('skips an organization whose subscription state is unreadable', async () => {
    mockEntitlements.getEffectivePlan.mockResolvedValueOnce(effectivePlan({ status: 'unknown' }));

    await build().processor(checkJob({ organizationId: 'org-1' }));

    expect(mockEmail.sendLowBalanceWarning).not.toHaveBeenCalled();
  });

  /**
   * The hot path enqueues on the balance it happened to see; a top-up between
   * enqueue and here must suppress the email.
   */
  it('skips when the authoritative bucket is above the threshold', async () => {
    mockPrisma.billingCreditBucket.findUnique.mockResolvedValueOnce({
      originalSeconds: 600,
      remainingSeconds: 300,
    });

    await build().processor(checkJob({ organizationId: 'org-1' }));

    expect(mockEmail.sendLowBalanceWarning).not.toHaveBeenCalled();
  });

  it('skips when the month has no free-grant bucket at all', async () => {
    mockPrisma.billingCreditBucket.findUnique.mockResolvedValueOnce(null);

    await build().processor(checkJob({ organizationId: 'org-1' }));

    expect(mockEmail.sendLowBalanceWarning).not.toHaveBeenCalled();
  });

  it('skips when the owner has no email address', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      name: 'Acme',
      owner: { email: '  ' },
    });

    await build().processor(checkJob({ organizationId: 'org-1' }));

    expect(mockEmail.sendLowBalanceWarning).not.toHaveBeenCalled();
  });

  it('propagates delivery failures so the job is retried', async () => {
    mockEmail.sendLowBalanceWarning.mockRejectedValueOnce(new Error('resend down'));

    await expect(
      build().processor(checkJob({ organizationId: 'org-1' })),
    ).rejects.toThrow('resend down');
  });

  it('throws on a job missing organizationId so BullMQ retries rather than silently no-oping', async () => {
    await expect(
      build().processor(checkJob({} as LowBalanceJob)),
    ).rejects.toThrow();
    expect(mockEmail.sendLowBalanceWarning).not.toHaveBeenCalled();
  });
});
