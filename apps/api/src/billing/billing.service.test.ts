import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BillingService, ForbiddenPlanError } from './billing.service';
import { env } from '../config/env';

function makePrisma(overrides?: {
  subscription?: unknown;
  agentCount?: number;
  usageRecords?: unknown[];
  workspace?: { organizationId: string };
  auditLog?: { create?: ReturnType<typeof vi.fn> };
}) {
  const state = {
    subscription: overrides?.subscription ?? null,
    agentCount: overrides?.agentCount ?? 0,
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
    },
    agent: {
      count: vi.fn(async () => state.agentCount),
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
      BILLING_MODE: 'live',
      STRIPE_SECRET_KEY: 'rk_test_123',
      STRIPE_STARTER_PRICE_ID: 'price_starter',
      STRIPE_GROWTH_PRICE_ID: 'price_growth',
      STRIPE_ENTERPRISE_PRICE_ID: 'price_enterprise',
      WEB_BASE_URL: 'https://app.voiceforge.test',
    });
    mockStripe = {
      customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
      checkout: { sessions: { create: vi.fn(async () => ({ url: 'https://checkout.stripe.com/c/session' })) } },
      billingPortal: { sessions: { create: vi.fn(async () => ({ url: 'https://billing.stripe.com/session' })) } },
    };
  });

  describe('getBillingStatus', () => {
    it('reports demo mode when live Stripe billing is disabled by env', () => {
      Object.assign(env, { BILLING_MODE: 'demo' });
      const prisma = makePrisma();
      const svc = makeService(prisma);

      expect(svc.getBillingStatus()).toEqual({
        mode: 'demo',
        liveCheckoutEnabled: false,
        message:
          'Live Stripe billing is disabled for this demo. Free trial limits remain active.',
      });
    });
  });

  describe('createCheckoutSession', () => {
    it('disables live checkout in demo billing mode without calling Stripe', async () => {
      Object.assign(env, { BILLING_MODE: 'demo' });
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
          automatic_tax: { enabled: true },
          billing_address_collection: 'required',
          tax_id_collection: { enabled: true },
          success_url: 'https://app.voiceforge.test/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://app.voiceforge.test/dashboard/billing?checkout=cancel',
          metadata: { organizationId: 'org-1', plan: 'starter' },
          subscription_data: {
            metadata: { organizationId: 'org-1', plan: 'starter' },
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
  });

  describe('createPortalSession', () => {
    it('disables the customer portal in demo billing mode without calling Stripe', async () => {
      Object.assign(env, { BILLING_MODE: 'demo' });
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
    it('returns true for outbound during the free trial allowance', async () => {
      const prisma = makePrisma({ subscription: { plan: 'free', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'outbound');
      expect(result).toBe(true);
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

    it('treats expired trialing as free plan for feature gates', async () => {
      const expiredTrial = new Date(Date.now() - 86400000); // yesterday
      const prisma = makePrisma({
        subscription: { plan: 'trialing', status: 'trialing', trialEnd: expiredTrial },
      });
      const svc = makeService(prisma);
      expect(await svc.checkFeatureGate('org-fake', 'outbound')).toBe(true);
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

    it('returns null warning for unlimited plan (enterprise)', async () => {
      const prisma = makePrisma({ subscription: { plan: 'enterprise', status: 'active' }, agentCount: 50 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).toBeNull();
      expect(result.limit).toBe(-1);
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

    it('does not throw for enterprise (unlimited)', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'enterprise', status: 'active' },
        agentCount: 999,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).resolves.toBeUndefined();
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
      expect(result.limits.calls).toBe(5); // free plan includes 5 trial outbound calls
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
});
