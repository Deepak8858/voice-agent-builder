import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BILLING_CATALOG_VERSION } from '@voiceforge/shared';
import { BillingService, ForbiddenPlanError } from './billing.service';
import { env } from '../config/env';

function makePrisma(overrides?: {
  subscription?: unknown;
  agentCount?: number;
  workspaceCount?: number;
  integrationToolCount?: number;
  creditBalance?: unknown;
  creditBuckets?: unknown[];
  usageRecords?: unknown[];
  workspace?: { organizationId: string };
  auditLog?: { create?: ReturnType<typeof vi.fn> };
}) {
  const state = {
    subscription: overrides?.subscription ?? null,
    agentCount: overrides?.agentCount ?? 0,
    workspaceCount: overrides?.workspaceCount ?? 0,
    integrationToolCount: overrides?.integrationToolCount ?? 0,
    creditBalance: overrides?.creditBalance ?? null,
    creditBuckets: overrides?.creditBuckets ?? [],
    usageRecords: overrides?.usageRecords ?? [],
    workspace: overrides?.workspace ?? { organizationId: 'org-1' },
  };
  return {
    subscription: {
      findUnique: vi.fn(async () => state.subscription),
      upsert: vi.fn(async () => ({ id: 'sub-1', ...state.subscription })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    organization: {
      findUniqueOrThrow: vi.fn(async () => ({ id: state.workspace.organizationId, name: 'Test Org' })),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(async () => state.workspace),
      findUnique: vi.fn(async () => state.workspace),
      count: vi.fn(async () => state.workspaceCount),
    },
    agent: {
      count: vi.fn(async () => state.agentCount),
    },
    integrationTool: {
      count: vi.fn(async () => state.integrationToolCount),
    },
    organizationCreditBalance: {
      findUnique: vi.fn(async () => state.creditBalance),
    },
    billingCreditBucket: {
      findMany: vi.fn(async () => state.creditBuckets),
    },
    usageRecord: {
      findMany: vi.fn(async () => state.usageRecords),
      create: vi.fn(async () => ({ id: 'ur-1' })),
    },
    auditLog: overrides?.auditLog ?? {
      create: vi.fn(async () => ({ id: 'audit-1' })),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  // We need a fresh module each time to avoid module-level Stripe caching
  // So we clear the require cache first
  return new BillingService(prisma as never);
}

describe('BillingService', () => {
  let mockStripe: {
    customers: { create: ReturnType<typeof vi.fn> };
    checkout: { sessions: { create: ReturnType<typeof vi.fn> } };
    billingPortal: { sessions: { create: ReturnType<typeof vi.fn> } };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(env, {
      STRIPE_SECRET_KEY: 'rk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
      STRIPE_STARTER_PRICE_ID: 'price_starter',
      STRIPE_GROWTH_PRICE_ID: 'price_growth',
      STRIPE_ENTERPRISE_PRICE_ID: 'price_enterprise',
      STRIPE_MINUTE_PACK_PRICE_ID: 'price_minute_pack',
      STRIPE_TAX_ENABLED: false,
      WEB_BASE_URL: 'https://app.voiceforge.test',
    });
    mockStripe = {
      customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
      checkout: { sessions: { create: vi.fn(async () => ({ url: 'https://checkout.stripe.com/c/session' })) } },
      billingPortal: { sessions: { create: vi.fn(async () => ({ url: 'https://billing.stripe.com/session' })) } },
    };
  });

  describe('getBillingStatus', () => {
    it('reports checkout configured when every server-owned identifier is present', () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      expect(svc.getBillingStatus()).toEqual({
        checkoutConfigured: true,
        liveCheckoutEnabled: true,
        message: 'Live Stripe checkout and customer portal actions are enabled.',
      });
    });

    /**
     * A partially configured deployment must fail closed. It reports checkout
     * as unavailable rather than advertising a free allowance, because the
     * webhook that grants what a customer pays for would not be verifiable.
     */
    it('reports checkout unavailable when the minute-pack price is missing', () => {
      Object.assign(env, { STRIPE_MINUTE_PACK_PRICE_ID: undefined });
      const prisma = makePrisma();
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      expect(svc.getBillingStatus()).toEqual({
        checkoutConfigured: false,
        liveCheckoutEnabled: false,
        message:
          'Stripe checkout is temporarily unavailable. No plan change was made and no free allowance was granted.',
      });
    });
  });

  describe('createCheckoutSession', () => {
    it('refuses checkout without calling Stripe when the webhook secret is missing', async () => {
      Object.assign(env, { STRIPE_WEBHOOK_SECRET: undefined });
      const prisma = makePrisma({ subscription: { stripeCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'starter',
        successPath: '/dashboard/billing?checkout=success',
        cancelPath: '/dashboard/billing?checkout=cancel',
      })).rejects.toMatchObject({
        errorCode: 'BILLING_UNAVAILABLE',
      });

      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('maps plan to server-owned price and enables production Checkout defaults', async () => {
      const prisma = makePrisma({ subscription: { stripeCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await svc.createCheckoutSession('org-1', {
        plan: 'starter',
        successPath: '/dashboard/billing?checkout=success',
        cancelPath: '/dashboard/billing?checkout=cancel',
      });

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_123',
          mode: 'subscription',
          line_items: [{ price: 'price_starter', quantity: 1 }],
          automatic_tax: { enabled: false },
          billing_address_collection: 'required',
          tax_id_collection: { enabled: true },
          success_url: 'https://app.voiceforge.test/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://app.voiceforge.test/dashboard/billing?checkout=cancel',
          metadata: expect.objectContaining({
            organizationId: 'org-1',
            plan: 'starter',
            catalogVersion: BILLING_CATALOG_VERSION,
          }),
          subscription_data: {
            metadata: {
              organizationId: 'org-1',
              plan: 'starter',
              catalogVersion: BILLING_CATALOG_VERSION,
            },
          },
        }),
      );
      expect(mockStripe.checkout.sessions.create.mock.calls[0][0]).not.toHaveProperty('payment_method_types');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.checkout_started',
            resourceType: 'subscription',
          }),
        }),
      );
    });

    /**
     * The identifier correlates one attempt between our audit log and Stripe's
     * dashboard, so it must be unique per request rather than per deployment.
     */
    it('stamps a distinct integration identifier on every Checkout attempt', async () => {
      const prisma = makePrisma({ subscription: { stripeCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });
      const dto = {
        plan: 'starter' as const,
        successPath: '/dashboard/billing?checkout=success',
        cancelPath: '/dashboard/billing?checkout=cancel',
      };

      await svc.createCheckoutSession('org-1', dto);
      await svc.createCheckoutSession('org-1', dto);

      const [first, second] = mockStripe.checkout.sessions.create.mock.calls.map(
        (call) => (call[0] as { metadata: Record<string, string> }).metadata.integration_identifier,
      );
      expect(first).toMatch(/^vf_[0-9a-f]{24}$/);
      expect(second).toMatch(/^vf_[0-9a-f]{24}$/);
      expect(first).not.toBe(second);
    });

    it('rejects unsafe checkout paths before calling Stripe', async () => {
      const prisma = makePrisma({ subscription: { stripeCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'starter',
        successPath: 'https://evil.example/success',
        cancelPath: '/dashboard/billing',
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    /**
     * Enterprise is sales-assisted and has no self-service Price. A forged plan
     * value must be refused before Stripe is contacted.
     */
    it('rejects a plan outside the self-service checkout catalog', async () => {
      const prisma = makePrisma({ subscription: { stripeCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'enterprise' as never,
        successPath: '/dashboard/billing',
        cancelPath: '/dashboard/billing',
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    });
  });

  describe('createTopUpCheckoutSession', () => {
    const topUpDto = {
      successPath: '/dashboard/billing?topup=success',
      cancelPath: '/dashboard/billing?topup=cancel',
    };

    it('starts a one-time Checkout against the server-owned minute-pack price', async () => {
      const prisma = makePrisma({
        subscription: {
          stripeCustomerId: 'cus_123',
          plan: 'growth',
          status: 'active',
          trialEnd: null,
          concurrentCallLimitOverride: null,
        },
      });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await svc.createTopUpCheckoutSession('org-1', topUpDto);

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_123',
          mode: 'payment',
          line_items: [{ price: 'price_minute_pack', quantity: 1 }],
          metadata: expect.objectContaining({
            organizationId: 'org-1',
            purchaseType: 'minute_pack',
            catalogVersion: BILLING_CATALOG_VERSION,
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'billing.topup_checkout_started' }),
        }),
      );
    });

    /**
     * Packs are consumed after included minutes, so an organization without a
     * funded subscription must not be able to buy one.
     */
    it('refuses a pack for an organization without paid access', async () => {
      const prisma = makePrisma({
        subscription: {
          stripeCustomerId: 'cus_123',
          plan: 'growth',
          status: 'past_due',
          trialEnd: null,
          concurrentCallLimitOverride: null,
        },
      });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await expect(svc.createTopUpCheckoutSession('org-1', topUpDto)).rejects.toBeInstanceOf(
        ForbiddenPlanError,
      );
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    });
  });

  describe('getBillingSummary', () => {
    const growthSubscription = {
      id: '5f7d4d3a-9a1f-4a2f-8f1a-2b3c4d5e6f70',
      plan: 'growth',
      status: 'active',
      currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
      trialEnd: null,
      concurrentCallLimitOverride: null,
      stripeCustomerId: 'cus_123',
    };

    function makeSummaryPrisma() {
      const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1_000);
      const later = new Date(Date.now() + 200 * 24 * 60 * 60 * 1_000);
      return makePrisma({
        subscription: growthSubscription,
        agentCount: 4,
        workspaceCount: 2,
        integrationToolCount: 3,
        creditBalance: {
          availableSeconds: 9_000,
          reservedSeconds: 120,
          status: 'active',
          reviewReason: null,
        },
        creditBuckets: [
          { sourceType: 'included', remainingSeconds: 3_000, expiresAt: soon },
          { sourceType: 'purchased', remainingSeconds: 6_000, expiresAt: later },
        ],
      });
    }

    it('separates included, purchased, reserved, and expiring seconds', async () => {
      const svc = makeService(makeSummaryPrisma());

      const summary = await svc.getBillingSummary('org-1');

      expect(summary).toMatchObject({
        organizationId: 'org-1',
        plan: 'growth',
        status: 'active',
        paidAccess: true,
        catalogVersion: BILLING_CATALOG_VERSION,
        currentPeriodEnd: '2026-09-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        includedSeconds: 3_000,
        purchasedSeconds: 6_000,
        reservedSeconds: 120,
        expiringSeconds: 0,
        availableSeconds: 9_000,
        balanceStatus: 'active',
        blockedReason: 'allowed',
      });
      expect(summary.entitlements).toMatchObject({
        includedMinutes: 1_000,
        agents: 10,
        workspaces: 5,
        concurrentCalls: 10,
        whiteLabel: true,
      });
    });

    /**
     * Quotas and credit belong to the organization, so the same totals must be
     * returned no matter which of its workspaces the dashboard was opened from.
     */
    it('returns organization totals rather than workspace-scoped counts', async () => {
      const prisma = makeSummaryPrisma();
      const svc = makeService(prisma);

      const summary = await svc.getBillingSummary('org-1');

      expect(summary.usage).toEqual({ agents: 4, workspaces: 2, integrations: 3 });
      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { workspace: { organizationId: 'org-1' } },
      });
      expect(prisma.workspace.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
      });
      expect(prisma.integrationTool.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
      });
    });

    /**
     * The summary is what a customer reads to understand why calls are not
     * running, so it must report the same denial the runtime would produce.
     */
    it('reports the reason a paid call would currently be refused', async () => {
      const prisma = makePrisma({
        subscription: { ...growthSubscription, status: 'past_due' },
      });
      const svc = makeService(prisma);

      const summary = await svc.getBillingSummary('org-1');

      expect(summary).toMatchObject({
        plan: 'free',
        status: 'past_due',
        paidAccess: false,
        blockedReason: 'subscription_inactive',
      });
    });

    it('reports zeroes for an organization that has never been granted credit', async () => {
      const svc = makeService(makePrisma({ subscription: null }));

      const summary = await svc.getBillingSummary('org-new');

      expect(summary).toMatchObject({
        plan: 'free',
        status: 'none',
        includedSeconds: 0,
        purchasedSeconds: 0,
        reservedSeconds: 0,
        expiringSeconds: 0,
        availableSeconds: 0,
        currentPeriodEnd: null,
      });
    });
  });

  describe('createPortalSession', () => {
    it('refuses the customer portal without calling Stripe when checkout is unconfigured', async () => {
      Object.assign(env, { STRIPE_WEBHOOK_SECRET: undefined });
      const prisma = makePrisma({ subscription: { stripeCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await expect(
        svc.createPortalSession('org-1', { returnPath: '/dashboard/billing' }),
      ).rejects.toMatchObject({
        errorCode: 'BILLING_UNAVAILABLE',
      });

      expect(mockStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('builds the Customer Portal return URL from WEB_BASE_URL', async () => {
      const prisma = makePrisma({ subscription: { stripeCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { stripe: typeof mockStripe }, { stripe: mockStripe });

      await svc.createPortalSession('org-1', { returnPath: '/dashboard/billing' });

      expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_123',
        return_url: 'https://app.voiceforge.test/dashboard/billing',
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.portal_opened',
            resourceType: 'subscription',
          }),
        }),
      );
    });
  });

  describe('getSubscription', () => {
    it('returns null for free org with no subscription row', async () => {
      const prisma = makePrisma({ subscription: null });
      const svc = makeService(prisma);
      const result = await svc.getSubscription('org-no-sub');
      expect(result).toBeNull();
    });

    it('returns subscription DTO when row exists', async () => {
      const sub = {
        id: 'sub-1',
        plan: 'starter',
        status: 'active',
        currentPeriodStart: new Date('2026-01-01'),
        currentPeriodEnd: new Date('2026-01-31'),
        cancelAtPeriodEnd: false,
        trialEnd: null,
        stripeCustomerId: 'cus_123',
      };
      const prisma = makePrisma({ subscription: sub });
      const svc = makeService(prisma);
      const result = await svc.getSubscription('org-1');
      expect(result).toMatchObject({
        id: 'sub-1',
        plan: 'starter',
        status: 'active',
        stripeCustomerId: 'cus_123',
      });
    });

    it('caches subscription DTOs in Redis for repeated dashboard billing checks', async () => {
      const sub = {
        id: 'sub-1',
        plan: 'growth',
        status: 'active',
        currentPeriodStart: new Date('2026-01-01'),
        currentPeriodEnd: new Date('2026-01-31'),
        cancelAtPeriodEnd: false,
        trialEnd: null,
        stripeCustomerId: 'cus_123',
      };
      const prisma = makePrisma({ subscription: sub });
      const cache = {
        get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'sub-1',
          plan: 'growth',
          status: 'active',
          currentPeriodStart: '2026-01-01T00:00:00.000Z',
          currentPeriodEnd: '2026-01-31T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          trialEnd: null,
          stripeCustomerId: 'cus_123',
        }),
        set: vi.fn(async () => undefined),
      };
      const svc = new BillingService(prisma as never, cache as never);

      await expect(svc.getSubscription('org-1')).resolves.toMatchObject({
        id: 'sub-1',
        plan: 'growth',
      });
      await expect(svc.getSubscription('org-1')).resolves.toMatchObject({
        id: 'sub-1',
        plan: 'growth',
      });

      expect(cache.get).toHaveBeenCalledWith('billing:subscription:org-1');
      expect(cache.set).toHaveBeenCalledWith(
        'billing:subscription:org-1',
        expect.objectContaining({ id: 'sub-1', plan: 'growth' }),
        60,
      );
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkFeatureGate', () => {
    it('returns false for outbound on free because browser tests are not PSTN calls', async () => {
      const prisma = makePrisma({ subscription: { plan: 'free', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'outbound');
      expect(result).toBe(false);
    });

    it('returns true for outbound on starter plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'outbound');
      expect(result).toBe(true);
    });

    it('returns false for white_label on starter plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'white_label');
      expect(result).toBe(false);
    });

    it('returns true for white_label on growth plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'growth', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'white_label');
      expect(result).toBe(true);
    });

    it('returns true for analytics on any paid plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const svc = makeService(prisma);
      expect(await svc.checkFeatureGate('org-fake', 'analytics')).toBe(true);
      expect(await svc.checkFeatureGate('org-fake', 'bulk_import')).toBe(true);
      expect(await svc.checkFeatureGate('org-fake', 'api_access')).toBe(true);
    });

    it('keeps tools and BYO telephony behind paid plans', async () => {
      const free = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));
      const starter = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      expect(await free.checkFeatureGate('org-fake', 'tools')).toBe(false);
      expect(await free.checkFeatureGate('org-fake', 'byo_telephony')).toBe(false);
      expect(await starter.checkFeatureGate('org-fake', 'tools')).toBe(true);
      expect(await starter.checkFeatureGate('org-fake', 'byo_telephony')).toBe(true);
    });

    it('treats expired trialing as free plan for feature gates', async () => {
      const expiredTrial = new Date(Date.now() - 86400000); // yesterday
      const prisma = makePrisma({
        subscription: { plan: 'trialing', status: 'trialing', trialEnd: expiredTrial },
      });
      const svc = makeService(prisma);
      expect(await svc.checkFeatureGate('org-fake', 'outbound')).toBe(false);
      expect(await svc.checkFeatureGate('org-fake', 'analytics')).toBe(false);
      expect(await svc.checkFeatureGate('org-fake', 'white_label')).toBe(false);
    });

    it('treats active trialing as paid plan for feature gates', async () => {
      const futureTrial = new Date(Date.now() + 86400000); // tomorrow
      const prisma = makePrisma({
        subscription: { plan: 'starter', status: 'trialing', trialEnd: futureTrial },
      });
      const svc = makeService(prisma);
      expect(await svc.checkFeatureGate('org-fake', 'outbound')).toBe(true);
      expect(await svc.checkFeatureGate('org-fake', 'analytics')).toBe(true);
    });
  });

  describe('checkAgentCreationWarning', () => {
    it('returns null warning when far below 80% threshold', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' }, agentCount: 0 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).toBeNull();
      expect(result.current).toBe(0);
      expect(result.limit).toBe(3);
    });

    it('returns warning at 80% for starter (2/3 agents)', async () => {
      // starter has 3 agents, 80% = floor(2.4) = 2, so 2 >= 2 && 2 <= 3 → warning
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' }, agentCount: 2 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('2/3');
      expect(result.current).toBe(2);
    });

    it('returns warning at 80% for free plan (1/1 agents)', async () => {
      // free has 1 agent, 80% = floor(0.8) = 0, so 1 >= 0 && 1 <= 1 → warning (at 100% of limit)
      const prisma = makePrisma({ subscription: { plan: 'free', status: 'active' }, agentCount: 1 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('1/1');
      expect(result.current).toBe(1);
    });

    it('returns a warning when enterprise reaches its 30-agent contract quota', async () => {
      const prisma = makePrisma({ subscription: { plan: 'enterprise', status: 'active' }, agentCount: 30 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).toContain('30/30');
      expect(result.limit).toBe(30);
    });
  });

  describe('enforceAgentLimit', () => {
    it('counts only published agents when enforcing publish limits', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'free', status: 'active' },
        agentCount: 0,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).resolves.toBeUndefined();
      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { workspace: { organizationId: 'org-fake' }, status: 'published' },
      });
    });

    it('throws ForbiddenPlanError when at limit (free, 1 agent)', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'free', status: 'active' },
        agentCount: 1,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).rejects.toBeInstanceOf(ForbiddenPlanError);
    });

    it('does not throw when below limit', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'free', status: 'active' },
        agentCount: 0,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).resolves.toBeUndefined();
    });

    it('throws when enterprise reaches its 30-agent contract quota', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'enterprise', status: 'active' },
        agentCount: 30,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).rejects.toBeInstanceOf(ForbiddenPlanError);
    });
  });

  describe('recordUsage', () => {
    it('creates a UsageRecord with calls metric', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await svc.recordUsage('ws-1', 'calls', 1);
      expect(prisma.usageRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-1',
            billableMetric: 'calls',
            quantity: 1,
          }),
        }),
      );
    });

    it('creates a UsageRecord with minutes metric', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await svc.recordUsage('ws-1', 'minutes', 5);
      expect(prisma.usageRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billableMetric: 'minutes',
            quantity: 5,
          }),
        }),
      );
    });
  });

  describe('getWorkspaceUsage', () => {
    it('returns zero metrics when no records exist', async () => {
      const prisma = makePrisma({ subscription: { plan: 'free', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.getWorkspaceUsage('ws-1');
      expect(result.workspaceId).toBe('ws-1');
      expect(result.usage.calls).toBe(0);
      expect(result.limits.calls).toBeUndefined();
    });

    it('sums up records by metric', async () => {
      const records = [
        { billableMetric: 'calls', quantity: 3, periodStart: new Date(), periodEnd: new Date() },
        { billableMetric: 'calls', quantity: 2, periodStart: new Date(), periodEnd: new Date() },
        { billableMetric: 'minutes', quantity: 60, periodStart: new Date(), periodEnd: new Date() },
      ];
      const prisma = makePrisma({
        subscription: { plan: 'starter', status: 'active' },
        usageRecords: records,
      });
      const svc = makeService(prisma);
      const result = await svc.getWorkspaceUsage('ws-1');
      expect(result.usage.calls).toBe(5);
      expect(result.usage.minutes).toBe(60);
    });
  });

  describe('canStartOutboundCall', () => {
    it('does not treat connected call history as a paid-plan call-count allowance', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'starter', status: 'active' },
        usageRecords: [{ billableMetric: 'calls', quantity: 2, periodStart: new Date(), periodEnd: new Date() }],
      });
      const svc = makeService(prisma);

      await expect(svc.canStartOutboundCall('ws-1')).resolves.toEqual({ allowed: true });
    });

    it('denies Free PSTN calls even though it has a browser-test entitlement', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));

      await expect(svc.canStartOutboundCall('ws-1')).resolves.toEqual({ allowed: false });
    });
  });
});
