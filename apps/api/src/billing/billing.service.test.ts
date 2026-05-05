import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService, ForbiddenPlanError } from './billing.service';

function makePrisma(overrides?: {
  subscription?: unknown;
  agentCount?: number;
  usageRecords?: unknown[];
  workspace?: { organizationId: string };
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
    // Preserve original env values but allow override per test
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
  });

  describe('checkFeatureGate', () => {
    it('returns false for outbound on free plan', async () => {
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

    it('returns null warning for unlimited plan (enterprise)', async () => {
      const prisma = makePrisma({ subscription: { plan: 'enterprise', status: 'active' }, agentCount: 50 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).toBeNull();
      expect(result.limit).toBe(-1);
    });
  });

  describe('enforceAgentLimit', () => {
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
      expect(result.limits.calls).toBe(0); // free plan has 0 outbound calls
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