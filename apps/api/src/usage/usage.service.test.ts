import { describe, expect, it, vi, beforeEach } from 'vitest';
import { UsageService } from './usage.service';
import { Prisma } from '@prisma/client';

function makePrisma(overrides?: {
  usageRecords?: Array<{ billableMetric: string; quantity: number }>;
  organization?: { id: string; plan: string } | null;
  planPrices?: Array<{ metric: string; pricePerUnit: Prisma.Decimal }>;
  agents?: Array<{ id: string; name: string }>;
  callAggregates?: Record<string, { _count: { _all: number }; _sum: { durationSeconds: number | null } }>;
}) {
  const state = {
    usageRecords: overrides?.usageRecords ?? [],
    organization: overrides?.organization ?? { id: 'org-1', plan: 'free' },
    planPrices: overrides?.planPrices ?? [],
    agents: overrides?.agents ?? [],
    callAggregates: overrides?.callAggregates ?? {},
  };

  return {
    usageRecord: {
      findMany: vi.fn(async () => state.usageRecords),
    },
    organization: {
      findUnique: vi.fn(async () => state.organization),
    },
    planPricing: {
      findMany: vi.fn(async () => state.planPrices),
    },
    agent: {
      findMany: vi.fn(async () => state.agents),
    },
    call: {
      aggregate: vi.fn(async ({ where }: { where: { agentId: string } }) => {
        return state.callAggregates[where.agentId] ?? { _count: { _all: 0 }, _sum: { durationSeconds: null } };
      }),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new UsageService(prisma as never);
}

describe('UsageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCurrentMonthUsage', () => {
    it('returns correct shape', async () => {
      const prisma = makePrisma({
        usageRecords: [
          { billableMetric: 'calls', quantity: 10 },
          { billableMetric: 'minutes', quantity: 300 },
        ],
        organization: { id: 'org-1', plan: 'starter' },
        planPrices: [
          { metric: 'calls', pricePerUnit: new Prisma.Decimal('0.05') },
          { metric: 'minutes', pricePerUnit: new Prisma.Decimal('0.02') },
        ],
      });
      const svc = makeService(prisma);
      const result = await svc.getCurrentMonthUsage('org-1');

      expect(result).toHaveProperty('org_id', 'org-1');
      expect(result).toHaveProperty('period');
      expect(result).toHaveProperty('total_calls', 10);
      expect(result).toHaveProperty('total_minutes', 300);
      expect(result).toHaveProperty('estimated_cost');
      expect(typeof result.estimated_cost).toBe('number');
    });

    it('sums multiple records per metric', async () => {
      const prisma = makePrisma({
        usageRecords: [
          { billableMetric: 'calls', quantity: 3 },
          { billableMetric: 'calls', quantity: 7 },
          { billableMetric: 'minutes', quantity: 100 },
          { billableMetric: 'minutes', quantity: 200 },
        ],
        organization: { id: 'org-1', plan: 'free' },
        planPrices: [],
      });
      const svc = makeService(prisma);
      const result = await svc.getCurrentMonthUsage('org-1');

      expect(result.total_calls).toBe(10);
      expect(result.total_minutes).toBe(300);
    });

    it('defaults to free plan when org not found', async () => {
      const prisma = makePrisma({
        usageRecords: [],
        organization: null,
        planPrices: [],
      });
      const svc = makeService(prisma);
      const result = await svc.getCurrentMonthUsage('org-unknown');
      expect(result.total_calls).toBe(0);
      expect(result.total_minutes).toBe(0);
    });
  });

  describe('getHistoricalUsage', () => {
    it('returns array', async () => {
      const prisma = makePrisma();
      const mockRows = [
        {
          org_id: 'org-1',
          period: '2026-04',
          total_calls: BigInt(50),
          total_minutes: BigInt(1200),
          estimated_cost: new Prisma.Decimal('25.00'),
          active_workspaces: BigInt(2),
        },
        {
          org_id: 'org-1',
          period: '2026-05',
          total_calls: BigInt(60),
          total_minutes: BigInt,
          estimated_cost: new Prisma.Decimal('30.00'),
          active_workspaces: BigInt(2),
        },
      ];
      (prisma as unknown as Record<string, unknown>).$queryRaw = vi.fn(async () => mockRows);

      const svc = makeService(prisma);
      const result = await svc.getHistoricalUsage('org-1', '2026-01', '2026-12');

      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty('period', '2026-04');
      expect(result[0]).toHaveProperty('total_calls', 50);
      expect(result[0]).toHaveProperty('total_minutes', 1200);
      expect(result[0]).toHaveProperty('estimated_cost', 25.00);
      expect(result[0]).toHaveProperty('active_workspaces', 2);
    });

    it('returns empty array when no data', async () => {
      const prisma = makePrisma();
      (prisma as unknown as Record<string, unknown>).$queryRaw = vi.fn(async () => []);

      const svc = makeService(prisma);
      const result = await svc.getHistoricalUsage('org-1', '2026-01', '2026-12');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('getAgentUsageBreakdown', () => {
    it('returns array with agent data', async () => {
      const prisma = makePrisma({
        agents: [
          { id: 'agent-1', name: 'Sales Bot' },
          { id: 'agent-2', name: 'Support Bot' },
        ],
        organization: { id: 'org-1', plan: 'starter' },
        planPrices: [
          { metric: 'calls', pricePerUnit: new Prisma.Decimal('0.05') },
          { metric: 'minutes', pricePerUnit: new Prisma.Decimal('0.02') },
        ],
        callAggregates: {
          'agent-1': { _count: { _all: 10 }, _sum: { durationSeconds: 600 } },
          'agent-2': { _count: { _all: 5 }, _sum: { durationSeconds: 300 } },
        },
      });
      const svc = makeService(prisma);
      const result = await svc.getAgentUsageBreakdown('org-1', '2026-05');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const agent1 = result.find((r) => r.agent_id === 'agent-1');
      expect(agent1).toHaveProperty('agent_name', 'Sales Bot');
      expect(agent1).toHaveProperty('total_calls', 10);
      expect(agent1).toHaveProperty('total_minutes');
      expect(typeof agent1!.total_minutes).toBe('number');
    });

    it('returns empty array when org has no agents', async () => {
      const prisma = makePrisma({
        agents: [],
        organization: { id: 'org-1', plan: 'free' },
        planPrices: [],
      });
      const svc = makeService(prisma);
      const result = await svc.getAgentUsageBreakdown('org-1', '2026-05');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('calculates correct minutes from durationSeconds', async () => {
      const prisma = makePrisma({
        agents: [{ id: 'agent-1', name: 'Test Agent' }],
        organization: { id: 'org-1', plan: 'free' },
        planPrices: [],
        callAggregates: {
          'agent-1': { _count: { _all: 3 }, _sum: { durationSeconds: 180 } },
        },
      });
      const svc = makeService(prisma);
      const result = await svc.getAgentUsageBreakdown('org-1', '2026-05');
      expect(result[0].total_minutes).toBe(3); // 180s / 60 = 3
    });
  });
});