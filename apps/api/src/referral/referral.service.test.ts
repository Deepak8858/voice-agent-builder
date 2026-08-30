import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferralService } from './referral.service';

/**
 * These four assertions exist because the money side of this module was wrong in
 * both directions at once: it wrote consumption rows while documenting a credit,
 * and it recorded conversions an organization could manufacture for itself.
 */
function makeService() {
  const prisma = {
    workspace: {
      findUnique: vi.fn(),
    },
    referral: {
      create: vi.fn(async () => ({ id: 'ref-1' })),
      findUnique: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
    },
    // Present precisely so a reintroduced "bonus" write would be observed
    // instead of throwing on an undefined delegate.
    usageRecord: {
      create: vi.fn(async () => ({ id: 'usage-1' })),
    },
    $transaction: vi.fn(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops as Promise<unknown>[]) : ops,
    ),
  };
  const audit = { log: vi.fn(async () => undefined) };

  return {
    prisma,
    audit,
    service: new ReferralService(prisma as never, audit as never),
  };
}

function pendingReferral(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ref-1',
    referrerUserId: 'user-referrer',
    referrerWorkspaceId: 'ws-referrer',
    referrerOrganizationId: 'org-referrer',
    status: 'pending',
    bonusMinutes: 100,
    inviteToken: 'token-1',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('ReferralService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a referral without writing a usage record', async () => {
    const { service, prisma } = makeService();
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referrer' });

    const result = await service.createReferral({
      actorUserId: 'user-referrer',
      referrerWorkspaceId: 'ws-referrer',
    });

    expect(result.inviteToken).toHaveLength(24);
    expect(prisma.referral.create).toHaveBeenCalledTimes(1);
    // A `minutes` usage record is consumption, not credit: writing one here
    // charged the referrer for the bonus it was supposed to receive.
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });

  it('accepts a referral without writing a usage record', async () => {
    const { service, prisma } = makeService();
    prisma.referral.findUnique.mockResolvedValue(pendingReferral());
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referred' });

    const result = await service.acceptReferral({
      inviteToken: 'token-1',
      referredUserId: 'user-referred',
      referredWorkspaceId: 'ws-referred',
    });

    expect(result.status).toBe('converted');
    expect(prisma.referral.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
    // Conversion grants nothing, so the award stamp must stay null. A timestamp
    // here is a false record of a completed award that a later idempotent grant
    // would read and use to skip the credit.
    expect(prisma.referral.updateMany).toHaveBeenCalledWith({
      where: { id: 'ref-1', status: 'pending' },
      data: {
        referredUserId: 'user-referred',
        referredWorkspaceId: 'ws-referred',
        referredOrganizationId: 'org-referred',
        status: 'converted',
      },
    });
  });

  it('refuses a referral converted inside the referrer organization', async () => {
    const { service, prisma } = makeService();
    prisma.referral.findUnique.mockResolvedValue(pendingReferral());
    // A second seat in the referrer's own organization: a different user id,
    // the same tenant.
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referrer' });

    await expect(
      service.acceptReferral({
        inviteToken: 'token-1',
        referredUserId: 'user-colleague',
        referredWorkspaceId: 'ws-colleague',
      }),
    ).rejects.toThrow('Cannot refer your own organization');
    expect(prisma.referral.updateMany).not.toHaveBeenCalled();
  });

  it('refuses the loser of two concurrent accepts of one token', async () => {
    const { service, prisma } = makeService();
    prisma.referral.findUnique.mockResolvedValue(pendingReferral());
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referred' });
    // Both callers read `pending`; the compare-and-set matched no row for this
    // one, so the other accept already converted it.
    prisma.referral.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.acceptReferral({
        inviteToken: 'token-1',
        referredUserId: 'user-referred',
        referredWorkspaceId: 'ws-referred',
      }),
    ).rejects.toThrow('Referral already converted');
  });
});
