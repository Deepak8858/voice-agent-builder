import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_CATALOG_VERSION } from '@voiceforge/shared';
import { EntitlementService, PlanQuotaExceededError } from './entitlement.service';

type SubscriptionRow = {
  plan: string;
  status: string;
  trialEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: Date | null;
  concurrentCallLimitOverride?: number | null;
} | null;

type BalanceRow = {
  availableSeconds: number;
  reservedSeconds: number;
  status: string;
  reviewReason: string | null;
} | null;

function makePrisma(overrides?: {
  subscription?: SubscriptionRow;
  balance?: BalanceRow;
  agentCount?: number;
  workspaceCount?: number;
  trialRedemption?: { maxDurationSeconds: number } | null;
}) {
  const subscription = overrides?.subscription ?? null;
  const balance =
    overrides?.balance === undefined
      ? { availableSeconds: 6_000, reservedSeconds: 0, status: 'active', reviewReason: null }
      : overrides.balance;
  const trialRedemption = overrides?.trialRedemption ?? null;
  return {
    subscription: {
      findUnique: vi.fn(async () => subscription),
    },
    organizationCreditBalance: {
      findUnique: vi.fn(async () => balance),
    },
    trialRedemption: {
      findUnique: vi.fn(async () => trialRedemption),
    },
    agent: { count: vi.fn(async () => overrides?.agentCount ?? 0) },
    workspace: { count: vi.fn(async () => overrides?.workspaceCount ?? 0) },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new EntitlementService(prisma as never);
}

describe('EntitlementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getEffectivePlan', () => {
    it.each(['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'])(
      'blocks paid calls when subscription status is %s',
      async (status) => {
        const svc = makeService(makePrisma({ subscription: { plan: 'starter', status } }));

        const decision = await svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60 });

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('subscription_inactive');
      },
    );

    it('allows an active subscription through its cancel-at-period end', async () => {
      const svc = makeService(
        makePrisma({
          subscription: {
            plan: 'growth',
            status: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date(Date.now() + 86_400_000),
          },
        }),
      );

      const plan = await svc.getEffectivePlan('org-1');

      expect(plan).toMatchObject({ plan: 'growth', status: 'active', paidAccess: true });
      await expect(
        svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: true, reason: 'allowed' });
    });

    it('allows an unexpired paid trial and rejects an expired paid trial', async () => {
      const unexpired = makeService(
        makePrisma({
          subscription: {
            plan: 'starter',
            status: 'trialing',
            trialEnd: new Date(Date.now() + 3_600_000),
          },
        }),
      );
      await expect(unexpired.getEffectivePlan('org-1')).resolves.toMatchObject({
        paidAccess: true,
        plan: 'starter',
      });

      const expired = makeService(
        makePrisma({
          subscription: {
            plan: 'starter',
            status: 'trialing',
            trialEnd: new Date(Date.now() - 3_600_000),
          },
        }),
      );
      const plan = await expired.getEffectivePlan('org-1');
      expect(plan.paidAccess).toBe(false);
      expect(plan.plan).toBe('free');
    });

    it('keeps Free on Free even when a legacy local subscription row says active', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));

      const plan = await svc.getEffectivePlan('org-1');

      expect(plan).toMatchObject({ plan: 'free', paidAccess: false });
    });

    it('returns a resolvable status for an organization that never subscribed', async () => {
      const svc = makeService(makePrisma({ subscription: null }));

      await expect(svc.getEffectivePlan('org-1')).resolves.toMatchObject({
        plan: 'free',
        status: 'none',
        paidAccess: false,
      });
    });

    it('clamps an Enterprise concurrency override to the contractual maximum of 50', async () => {
      const svc = makeService(
        makePrisma({
          subscription: {
            plan: 'enterprise',
            status: 'active',
            concurrentCallLimitOverride: 120,
          },
        }),
      );

      const plan = await svc.getEffectivePlan('org-1');

      expect(plan.entitlements.concurrentCalls).toBe(50);
    });

    it('ignores a stale concurrency override on plans that cannot contract one', async () => {
      const svc = makeService(
        makePrisma({
          subscription: {
            plan: 'starter',
            status: 'active',
            concurrentCallLimitOverride: 25,
          },
        }),
      );

      const plan = await svc.getEffectivePlan('org-1');

      expect(plan.entitlements.concurrentCalls).toBe(2);
    });
  });

  describe('check', () => {
    it('returns stable current, limit, reason, and catalogVersion fields', async () => {
      const svc = makeService(
        makePrisma({ subscription: { plan: 'starter', status: 'active' }, agentCount: 1 }),
      );

      const decision = await svc.check('org-1', { kind: 'agent_create', current: 1 });

      expect(decision).toMatchObject({
        organizationId: 'org-1',
        plan: 'starter',
        allowed: true,
        reason: 'allowed',
        current: 1,
        limit: 3,
        catalogVersion: BILLING_CATALOG_VERSION,
      });
      expect(decision.correlationId).toMatch(/^ent_/);
    });

    it('evaluates agents and workspaces across the organization, not one workspace', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      await expect(svc.check('org-1', { kind: 'agent_create', current: 3 })).resolves.toMatchObject({
        allowed: false,
        reason: 'agent_limit_reached',
        current: 3,
        limit: 3,
      });
      await expect(
        svc.check('org-1', { kind: 'workspace_create', current: 1 }),
      ).resolves.toMatchObject({
        allowed: false,
        reason: 'workspace_limit_reached',
        limit: 1,
      });
    });

    it('shares one connection quota across CRM and Calendar integrations', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'growth', status: 'active' } }));

      await expect(
        svc.check('org-1', { kind: 'integration_connect', current: 9 }),
      ).resolves.toMatchObject({ allowed: true, limit: 10 });
      await expect(
        svc.check('org-1', { kind: 'integration_connect', current: 10 }),
      ).resolves.toMatchObject({ allowed: false, reason: 'integration_limit_reached' });
    });

    it('blocks Free outbound PSTN even when legacy UsageRecord rows exist', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));

      await expect(
        svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: false, reason: 'subscription_required' });
      await expect(svc.check('org-1', { kind: 'campaign_launch' })).resolves.toMatchObject({
        allowed: false,
        reason: 'subscription_required',
      });
    });

    it('allows exactly one lifetime browser test allowance on Free', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));

      await expect(svc.check('org-1', { kind: 'browser_test' })).resolves.toMatchObject({
        allowed: true,
        reason: 'allowed',
        limit: 180,
      });
    });

    it('refuses a second browser test once the lifetime allowance is redeemed', async () => {
      const svc = makeService(
        makePrisma({
          subscription: { plan: 'free', status: 'active' },
          trialRedemption: { maxDurationSeconds: 180 },
        }),
      );

      await expect(svc.check('org-1', { kind: 'browser_test' })).resolves.toMatchObject({
        allowed: false,
        reason: 'trial_already_used',
        current: 180,
        limit: 180,
      });
    });

    it('does not spend the trial allowance for a paid organization', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'starter', status: 'active' },
        trialRedemption: { maxDurationSeconds: 180 },
      });
      const svc = makeService(prisma);

      await expect(svc.check('org-1', { kind: 'browser_test' })).resolves.toMatchObject({
        allowed: true,
        reason: 'allowed',
      });
      expect(prisma.trialRedemption.findUnique).not.toHaveBeenCalled();
    });

    it('blocks paid calls while the credit balance is in manual review', async () => {
      const svc = makeService(
        makePrisma({
          subscription: { plan: 'starter', status: 'active' },
          balance: {
            availableSeconds: 6_000,
            reservedSeconds: 0,
            status: 'blocked',
            reviewReason: 'refund under review',
          },
        }),
      );

      await expect(
        svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: false, reason: 'billing_temporarily_unavailable' });
    });

    it('refuses a paid call when fewer than the requested seconds remain', async () => {
      const svc = makeService(
        makePrisma({
          subscription: { plan: 'starter', status: 'active' },
          balance: {
            availableSeconds: 59,
            reservedSeconds: 0,
            status: 'active',
            reviewReason: null,
          },
        }),
      );

      await expect(
        svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({
        allowed: false,
        reason: 'credit_insufficient',
        current: 59,
        limit: 60,
      });
    });

    it('treats a missing balance projection as zero funded seconds', async () => {
      const svc = makeService(
        makePrisma({ subscription: { plan: 'starter', status: 'active' }, balance: null }),
      );

      await expect(
        svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: false, reason: 'credit_insufficient', current: 0 });
    });

    it('gates white label on the plan entitlement rather than the plan name', async () => {
      const growth = makeService(makePrisma({ subscription: { plan: 'growth', status: 'active' } }));
      await expect(growth.check('org-1', { kind: 'white_label' })).resolves.toMatchObject({
        allowed: true,
      });

      const starter = makeService(
        makePrisma({ subscription: { plan: 'starter', status: 'active' } }),
      );
      await expect(starter.check('org-1', { kind: 'white_label' })).resolves.toMatchObject({
        allowed: false,
        reason: 'subscription_required',
      });
    });
  });

  describe('assertAllowed', () => {
    it('returns the decision when the organization is within its plan', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      await expect(
        svc.assertAllowed('org-1', { kind: 'agent_create', current: 0 }),
      ).resolves.toMatchObject({ allowed: true });
    });

    it('throws a quota error carrying the stable reason and limits', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      await expect(
        svc.assertAllowed('org-1', { kind: 'agent_create', current: 3 }),
      ).rejects.toMatchObject({
        errorCode: 'PLAN_LIMIT_EXCEEDED',
        details: expect.objectContaining({
          reason: 'agent_limit_reached',
          current: 3,
          limit: 3,
          plan: 'starter',
        }),
      });
    });

    it('audits every denial with its correlation id', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const svc = makeService(prisma);

      await expect(
        svc.assertAllowed('org-1', { kind: 'workspace_create', current: 1 }),
      ).rejects.toBeInstanceOf(PlanQuotaExceededError);

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.entitlement_denied',
            resourceType: 'subscription',
            metadata: expect.objectContaining({
              reason: 'workspace_limit_reached',
              correlationId: expect.stringMatching(/^ent_/),
            }),
          }),
        }),
      );
    });

    it('does not audit an allowed decision', async () => {
      const prisma = makePrisma({ subscription: { plan: 'growth', status: 'active' } });
      const svc = makeService(prisma);

      await svc.assertAllowed('org-1', { kind: 'agent_create', current: 0 });

      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
