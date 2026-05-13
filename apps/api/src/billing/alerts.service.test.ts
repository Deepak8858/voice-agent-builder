import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertsService } from './alerts.service';

function makePrisma(overrides?: {
  subscription?: unknown;
  usageRecords?: Array<{ billableMetric: string; _sum: { quantity: bigint | null } }>;
  organizations?: unknown[];
  alerts?: unknown[];
}) {
  const state = {
    subscription: overrides?.subscription ?? null,
    usageRecords: overrides?.usageRecords ?? [],
    organizations: overrides?.organizations ?? [],
    alerts: overrides?.alerts ?? [],
  };
  return {
    subscription: {
      findUnique: vi.fn(async () => state.subscription),
    },
    usageRecord: {
      groupBy: vi.fn(async () => state.usageRecords),
    },
    organization: {
      findMany: vi.fn(async () => state.organizations),
    },
    alert: {
      findFirst: vi.fn(async () => state.alerts[0] ?? null),
      create: vi.fn(async () => ({ id: 'alert-1' })),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  // EmailService is only used for side-effects (sending emails) — we mock at the call site
  const emailService = {
    sendOverageAlert: vi.fn(async () => ({ delivered: true })),
  } as never;
  return new AlertsService(prisma as never, emailService);
}

describe('AlertsService', () => {
  let mockPrisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    mockPrisma = makePrisma();
    const svc = makeService(mockPrisma);
    expect(svc).toBeDefined();
  });

  it('should check overage alert correctly for org with no subscription', async () => {
    mockPrisma = makePrisma({ subscription: null, usageRecords: [] });
    const svc = makeService(mockPrisma);
    const result = await svc.checkOverageAlert('non-existent-org');
    expect(typeof result.atLimit).toBe('boolean');
    expect(typeof result.warningThreshold).toBe('boolean');
    expect(typeof result.percentage).toBe('number');
    expect(typeof result.calls).toBe('object');
    expect(typeof result.minutes).toBe('object');
  });

  it('should check overage alert with usage records', async () => {
    mockPrisma = makePrisma({
      subscription: { plan: 'starter', status: 'active' },
      usageRecords: [
        { billableMetric: 'calls', _sum: { quantity: BigInt(5) } },
        { billableMetric: 'minutes', _sum: { quantity: BigInt(100) } },
      ],
    });
    const svc = makeService(mockPrisma);
    const result = await svc.checkOverageAlert('org-1');
    expect(result.calls.used).toBe(5);
    expect(result.minutes.used).toBe(100);
    expect(result.warningThreshold).toBe(false);
    expect(result.atLimit).toBe(false);
  });

  it('should flag atLimit when usage reaches 100%', async () => {
    mockPrisma = makePrisma({
      subscription: { plan: 'starter', status: 'active' },
      usageRecords: [
        { billableMetric: 'calls', _sum: { quantity: BigInt(100) } },
        { billableMetric: 'minutes', _sum: { quantity: BigInt(300) } },
      ],
    });
    const svc = makeService(mockPrisma);
    const result = await svc.checkOverageAlert('org-1');
    expect(result.atLimit).toBe(true);
  });

  it('should flag warningThreshold when usage is at or above 80%', async () => {
    mockPrisma = makePrisma({
      subscription: { plan: 'starter', status: 'active' },
      usageRecords: [
        { billableMetric: 'calls', _sum: { quantity: BigInt(80) } },
        { billableMetric: 'minutes', _sum: { quantity: BigInt(100) } },
      ],
    });
    const svc = makeService(mockPrisma);
    const result = await svc.checkOverageAlert('org-1');
    expect(result.warningThreshold).toBe(true);
    expect(result.atLimit).toBe(false);
  });
});