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
}) {
  const subscription = overrides?.subscription ?? null;
  const balance =
    overrides?.balance === undefined
      ? { availableSeconds: 6_000, reservedSeconds: 0, status: 'active', reviewReason: null }
      : overrides.balance;
  return {
    subscription: {
      findUnique: vi.fn(async () => subscription),
    },
    organizationCreditBalance: {
      findUnique: vi.fn(async () => balance),
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

    /**
     * `status` alone is not proof of funding. Stripe advances the period when it
     * generates the renewal invoice, so a row whose `currentPeriodEnd` is still
     * days in the past is one whose renewal webhook never arrived — and it used
     * to read as `active`, and therefore paid, forever.
     */
    it('refuses paid access to an active subscription whose period ended and was never renewed', async () => {
      const svc = makeService(
        makePrisma({
          subscription: {
            plan: 'growth',
            status: 'active',
            currentPeriodEnd: new Date(Date.now() - 3 * 86_400_000),
          },
        }),
      );

      const plan = await svc.getEffectivePlan('org-1');

      expect(plan.paidAccess).toBe(false);
      expect(plan.plan).toBe('free');
    });

    /**
     * The refusal must not read as "subscribe to continue". A lapsed period
     * leaves `status` at `active` and downgrades `plan` to free, so the reason is
     * the only field left that can tell a missed renewal webhook apart from an
     * organization that never subscribed — and the remedies differ: one is a
     * payment fix, the other is a purchase.
     */
    it('reports a lapsed period as inactive rather than as never having subscribed', async () => {
      const lapsed = makeService(
        makePrisma({
          subscription: {
            plan: 'growth',
            status: 'active',
            currentPeriodEnd: new Date(Date.now() - 3 * 86_400_000),
          },
        }),
      );
      const neverSubscribed = makeService(makePrisma({ subscription: null }));

      await expect(
        lapsed.check('org-1', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: false, reason: 'subscription_inactive' });
      await expect(
        neverSubscribed.check('org-2', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: false, reason: 'subscription_required' });
    });

    it('keeps paid access through the renewal window while the period-end webhook is in flight', async () => {
      const svc = makeService(
        makePrisma({
          subscription: {
            plan: 'growth',
            status: 'active',
            // Just past the boundary: Stripe finalizes and pays the renewal
            // invoice about an hour after it is created, so downgrading here
            // would cut off every paying customer at every renewal.
            currentPeriodEnd: new Date(Date.now() - 60 * 60 * 1000),
          },
        }),
      );

      await expect(svc.getEffectivePlan('org-1')).resolves.toMatchObject({
        paidAccess: true,
        plan: 'growth',
      });
    });

    it('treats a subscription with no recorded period as funded, not expired', async () => {
      // The checkout upsert creates the row before Stripe reports a period, and
      // a subscription event that omits it persists null on purpose.
      const svc = makeService(
        makePrisma({ subscription: { plan: 'starter', status: 'active', currentPeriodEnd: null } }),
      );

      await expect(svc.getEffectivePlan('org-1')).resolves.toMatchObject({ paidAccess: true });
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

    /**
     * A zero or negative override would silently mean "this Enterprise
     * customer can never place a call". The contractual floor is one, so a
     * mistyped override degrades to the minimum rather than to an outage.
     */
    it.each([0, -5])('raises an override of %s to the contractual minimum of 1', async (override) => {
      const svc = makeService(
        makePrisma({
          subscription: {
            plan: 'enterprise',
            status: 'active',
            concurrentCallLimitOverride: override,
          },
        }),
      );

      const plan = await svc.getEffectivePlan('org-1');

      expect(plan.entitlements.concurrentCalls).toBe(1);
    });

    /**
     * A stored status outside the shared contract is corruption. Reporting it
     * as `none` would tell a paying organization to subscribe, so it is
     * surfaced as `unknown` and paid usage stops until a human corrects it.
     */
    it('surfaces a status outside the shared contract as unknown rather than none', async () => {
      const svc = makeService(
        makePrisma({ subscription: { plan: 'growth', status: 'not_a_stripe_status' } }),
      );

      const plan = await svc.getEffectivePlan('org-1');

      expect(plan).toMatchObject({ plan: 'free', status: 'unknown', paidAccess: false });
      await expect(
        svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: false, reason: 'billing_temporarily_unavailable' });
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

    /**
     * A browser test is the one metered call a plan without PSTN may start, so
     * it must be allowed on Free even though outbound calling is not — as long
     * as the monthly allowance still has a billable minute in it.
     */
    it('funds a Free browser test from the monthly allowance', async () => {
      const svc = makeService(
        makePrisma({
          subscription: { plan: 'free', status: 'active' },
          balance: {
            availableSeconds: 600,
            reservedSeconds: 0,
            status: 'active',
            reviewReason: null,
          },
        }),
      );

      await expect(
        svc.check('org-1', { kind: 'browser_test', minimumSeconds: 60 }),
      ).resolves.toMatchObject({
        allowed: true,
        reason: 'allowed',
        current: 600,
        limit: 60,
      });
    });

    it('refuses a browser test once the monthly allowance is spent', async () => {
      const svc = makeService(
        makePrisma({
          subscription: { plan: 'free', status: 'active' },
          balance: {
            availableSeconds: 30,
            reservedSeconds: 0,
            status: 'active',
            reviewReason: null,
          },
        }),
      );

      await expect(
        svc.check('org-1', { kind: 'browser_test', minimumSeconds: 60 }),
      ).resolves.toMatchObject({
        allowed: false,
        reason: 'credit_insufficient',
        current: 30,
        limit: 60,
      });
    });

    /**
     * The recurring allowance replaced a one-time trial. A Free organization
     * that has already run tests this month must still be able to run another
     * one, which is precisely what the retired lifetime cap prevented.
     */
    it('allows repeated Free browser tests while the allowance lasts', async () => {
      const svc = makeService(
        makePrisma({
          subscription: { plan: 'free', status: 'active' },
          balance: {
            availableSeconds: 420,
            reservedSeconds: 180,
            status: 'active',
            reviewReason: null,
          },
        }),
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          svc.check('org-1', { kind: 'browser_test', minimumSeconds: 60 }),
        ).resolves.toMatchObject({ allowed: true, reason: 'allowed' });
      }
    });

    it('tells a Free organization to upgrade or wait rather than buy a pack', async () => {
      // Minute packs are sold only to paid subscriptions, so the pack message
      // would describe a remedy a Free organization cannot act on.
      const svc = makeService(
        makePrisma({
          subscription: { plan: 'free', status: 'active' },
          balance: { availableSeconds: 0, reservedSeconds: 0, status: 'active', reviewReason: null },
        }),
      );

      await expect(
        svc.assertAllowed('org-1', { kind: 'browser_test', minimumSeconds: 60 }),
      ).rejects.toThrow(/free minutes for this month/i);
    });

    it('funds a paid browser test from the same balance as a telephony call', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      await expect(
        svc.check('org-1', { kind: 'browser_test', minimumSeconds: 60 }),
      ).resolves.toMatchObject({ allowed: true, reason: 'allowed' });
    });

    /**
     * A runtime the plan does not sell is not a credit problem, so the refusal
     * must name the runtime and must not depend on the balance — otherwise a
     * well-funded organization would be told to buy minutes it already has.
     */
    it('refuses a pipeline the plan does not sell before consulting credit', async () => {
      const prisma = makePrisma({ subscription: { plan: 'growth', status: 'active' } });
      const svc = makeService(prisma);

      await expect(
        svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60, pipeline: 'standard' }),
      ).resolves.toMatchObject({ allowed: false, reason: 'pipeline_not_entitled' });
      expect(prisma.organizationCreditBalance.findUnique).not.toHaveBeenCalled();
    });

    it('allows a starter call on either runtime it is sold', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      for (const pipeline of ['realtime', 'standard'] as const) {
        await expect(
          svc.check('org-1', { kind: 'paid_call', minimumSeconds: 60, pipeline }),
        ).resolves.toMatchObject({ allowed: true, reason: 'allowed' });
      }
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

    it('preserves the quota denial when its audit write fails', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));
      const svc = makeService(prisma);

      await expect(
        svc.assertAllowed('org-1', { kind: 'workspace_create', current: 1 }),
      ).rejects.toMatchObject({
        errorCode: 'PLAN_LIMIT_EXCEEDED',
        details: expect.objectContaining({ reason: 'workspace_limit_reached' }),
      });

      // The denial must still have been *attempted* as an audit write, so a
      // passing assertion here cannot be explained by the audit call being
      // skipped rather than by its failure being swallowed.
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('does not audit an allowed decision', async () => {
      const prisma = makePrisma({ subscription: { plan: 'growth', status: 'active' } });
      const svc = makeService(prisma);

      await svc.assertAllowed('org-1', { kind: 'agent_create', current: 0 });

      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
