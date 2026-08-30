import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferralService } from './referral.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

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
      create: vi.fn(async (_args: { data: { inviteToken: string } }) => ({ id: 'ref-1' })),
      findUnique: vi.fn(),
      update: vi.fn(async () => ({ id: 'ref-1' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
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

  // S-007: `referrals.invite_token` held the bearer token itself, so a read of
  // the table (or of the referral list endpoint) yielded redeemable invites.
  it('stores only the digest of the invite token it returns once', async () => {
    const { service, prisma } = makeService();
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referrer' });

    const { inviteToken } = await service.createReferral({
      actorUserId: 'user-referrer',
      referrerWorkspaceId: 'ws-referrer',
    });

    const stored = prisma.referral.create.mock.calls[0][0].data.inviteToken;
    expect(stored).not.toBe(inviteToken);
    expect(stored).toBe(sha256(inviteToken));
  });

  it('accepts the plaintext token whose digest is stored', async () => {
    const { service, prisma } = makeService();
    const plain = 'A'.repeat(24);
    prisma.referral.findUnique.mockImplementation(async ({ where }: any) =>
      where.inviteToken === sha256(plain) ? pendingReferral({ inviteToken: sha256(plain) }) : null,
    );
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referred' });

    const result = await service.acceptReferral({
      inviteToken: plain,
      referredUserId: 'user-referred',
      referredWorkspaceId: 'ws-referred',
    });

    expect(result.status).toBe('converted');
    // Nothing to upgrade: the row was written hashed.
    expect(prisma.referral.update).not.toHaveBeenCalled();
  });

  it('resolves a pre-hash plaintext row and upgrades it to a digest', async () => {
    const { service, prisma } = makeService();
    const plain = 'B'.repeat(24);
    prisma.referral.findUnique.mockImplementation(async ({ where }: any) =>
      where.inviteToken === plain ? pendingReferral({ inviteToken: plain }) : null,
    );
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referred' });

    const result = await service.acceptReferral({
      inviteToken: plain,
      referredUserId: 'user-referred',
      referredWorkspaceId: 'ws-referred',
    });

    expect(result.status).toBe('converted');
    expect(prisma.referral.update).toHaveBeenCalledWith({
      where: { id: 'ref-1' },
      data: { inviteToken: sha256(plain) },
    });
  });

  // The digest is not a second copy of the credential: the plaintext fallback
  // must not accept a value read straight out of the column.
  it('refuses a stored digest presented as the token', async () => {
    const { service, prisma } = makeService();
    const stored = sha256('C'.repeat(24));
    prisma.referral.findUnique.mockImplementation(async ({ where }: any) =>
      where.inviteToken === stored ? pendingReferral({ inviteToken: stored }) : null,
    );
    // Everything downstream would succeed, so the rejection can only come from
    // the lookup refusing to treat a digest as its own plaintext.
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-referred' });

    await expect(
      service.acceptReferral({
        inviteToken: stored,
        referredUserId: 'user-referred',
        referredWorkspaceId: 'ws-referred',
      }),
    ).rejects.toThrow('Invalid referral token');
    expect(prisma.referral.updateMany).not.toHaveBeenCalled();
  });

  it('never returns the invite token from listReferrals', async () => {
    const { service, prisma } = makeService();
    prisma.referral.findMany.mockResolvedValue([
      { ...pendingReferral({ inviteToken: 'still-secret' }), createdAt: new Date() },
    ]);

    const rows = await service.listReferrals('ws-referrer');
    expect(rows).toHaveLength(1);
    expect(rows[0].inviteToken).toBe('');
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
