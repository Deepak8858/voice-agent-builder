import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

function makePrisma(overrides?: {
  $queryRaw?: ReturnType<typeof vi.fn>;
  organization?: { id: string; plan: string } | null;
  usageRecords?: Array<{ billableMetric: string; quantity: number }>;
  planPrices?: Array<{ metric: string; pricePerUnit: { toNumber(): number } }>;
  workspaceCount?: number;
}) {
  const state = {
    organization: overrides?.organization ?? { id: 'org-1', plan: 'free' },
    usageRecords: overrides?.usageRecords ?? [],
    planPrices: overrides?.planPrices ?? [],
    workspaceCount: overrides?.workspaceCount ?? 1,
  };

  return {
    $queryRaw: overrides?.$queryRaw ?? vi.fn(async () => []),
    organization: {
      findUnique: vi.fn(async () => state.organization),
    },
    usageRecord: {
      findMany: vi.fn(async () => state.usageRecords),
    },
    planPricing: {
      findMany: vi.fn(async () => state.planPrices),
    },
    workspace: {
      count: vi.fn(async () => state.workspaceCount),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>, usageService: UsageService) {
  return new AdminService(prisma as never, usageService);
}

describe('AdminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    const prisma = makePrisma();
    const usageService = { getAgentUsageBreakdown: vi.fn() } as never;
    const service = makeService(prisma, usageService);
    expect(service).toBeDefined();
  });

  it('should be instantiable with mock dependencies', () => {
    const prisma = makePrisma();
    const usageService = { getAgentUsageBreakdown: vi.fn() } as never;
    const service = makeService(prisma, usageService);
    expect(service).toBeInstanceOf(AdminService);
  });
});