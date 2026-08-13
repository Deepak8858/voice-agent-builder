import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_COST_CATEGORIES,
  PROVIDER_COST_ESTIMATE_VERSION,
  ProviderCostService,
} from './provider-cost.service';

const ORG = 'org-1';
const CALL = 'call-1';

interface UpsertArgs {
  where: { provider_idempotencyKey: { provider: string; idempotencyKey: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

function makeService(opts: { callUsages?: unknown[]; counts?: number[] } = {}) {
  const upsert = vi.fn(async (_args: UpsertArgs) => ({}));
  const countQueue = [...(opts.counts ?? [])];
  const prisma = {
    providerCostEvent: { upsert },
    callUsage: {
      findMany: vi.fn(async () => opts.callUsages ?? []),
      count: vi.fn(async () => countQueue.shift() ?? 0),
    },
  };
  const metrics = {
    providerCostUsdTotal: { labels: vi.fn(() => ({ inc: vi.fn() })) },
  };
  return {
    prisma,
    upsert,
    metrics,
    service: new ProviderCostService(prisma as never, metrics as never),
  };
}

function upsertArgs(upsert: ReturnType<typeof vi.fn>, index = 0): UpsertArgs {
  const call = upsert.mock.calls[index];
  if (!call) throw new Error(`no upsert recorded at index ${index}`);
  return call[0] as UpsertArgs;
}

describe('ProviderCostService.estimateConnectedCall', () => {
  beforeEach(() => vi.clearAllMocks());

  it('estimates a connected minute at the configured reserve rate', async () => {
    const { service, upsert } = makeService();

    await service.estimateConnectedCall({
      organizationId: ORG,
      workspaceId: 'ws-1',
      callId: CALL,
      provider: 'livekit',
      connectedSeconds: 60,
      occurredAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const args = upsertArgs(upsert);
    expect(Number(args.create.amount)).toBeCloseTo(service.reservePerMinuteUsd, 6);
    expect(Number(args.create.quantity)).toBe(1);
    expect(args.create.measuredUnit).toBe('minute');
    expect(args.create.isEstimate).toBe(true);
    expect(args.create.estimateVersion).toBe(PROVIDER_COST_ESTIMATE_VERSION);
    expect(args.create.reconciledAt).toBeNull();
  });

  it('charges a started minute as a whole minute', async () => {
    const { service, upsert } = makeService();

    await service.estimateConnectedCall({
      organizationId: ORG,
      callId: CALL,
      provider: 'livekit',
      connectedSeconds: 61,
      occurredAt: new Date(),
    });

    // 61 seconds is two started minutes, matching how the customer is billed.
    expect(Number(upsertArgs(upsert).create.quantity)).toBe(2);
  });

  it('keys estimates per call, category, and estimate version', async () => {
    const { service, upsert } = makeService();

    await service.estimateConnectedCall({
      organizationId: ORG,
      callId: CALL,
      provider: 'livekit',
      connectedSeconds: 30,
      occurredAt: new Date(),
      serviceCategory: PROVIDER_COST_CATEGORIES.sipTrunk,
    });

    expect(upsertArgs(upsert).where.provider_idempotencyKey.idempotencyKey).toBe(
      `estimate:call:${CALL}:${PROVIDER_COST_CATEGORIES.sipTrunk}:v${PROVIDER_COST_ESTIMATE_VERSION}`,
    );
  });

  it('never overwrites a settled figure when re-estimating', async () => {
    const { service, upsert } = makeService();

    await service.estimateConnectedCall({
      organizationId: ORG,
      callId: CALL,
      provider: 'livekit',
      connectedSeconds: 60,
      occurredAt: new Date(),
    });

    // An empty update clause means a replayed estimate leaves an existing
    // actual figure exactly as it was.
    expect(upsertArgs(upsert).update).toEqual({});
  });
});

describe('ProviderCostService.recordActualCost', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces an estimate with the actual provider figure', async () => {
    const { service, upsert } = makeService();

    await service.recordActualCost({
      organizationId: ORG,
      callId: CALL,
      provider: 'openai',
      serviceCategory: PROVIDER_COST_CATEGORIES.llm,
      idempotencyKey: 'openai:usage:abc',
      measuredUnit: 'token',
      quantity: 12_500,
      amountUsd: 0.3125,
      occurredAt: new Date(),
      providerUsageId: 'usage_abc',
    });

    const args = upsertArgs(upsert);
    expect(args.update).toMatchObject({ isEstimate: false, estimateVersion: 0 });
    expect(Number(args.update.amount)).toBeCloseTo(0.3125, 6);
    expect(args.update.reconciledAt).toBeInstanceOf(Date);
  });

  it('records each service category separately', async () => {
    const { service, upsert } = makeService();
    const base = {
      organizationId: ORG,
      callId: CALL,
      measuredUnit: 'minute',
      quantity: 1,
      amountUsd: 0.05,
      occurredAt: new Date(),
    };

    await service.recordActualCost({
      ...base,
      provider: 'openai',
      serviceCategory: PROVIDER_COST_CATEGORIES.llm,
      idempotencyKey: 'k1',
    });
    await service.recordActualCost({
      ...base,
      provider: 'livekit',
      serviceCategory: PROVIDER_COST_CATEGORIES.agentRuntime,
      idempotencyKey: 'k2',
    });
    await service.recordActualCost({
      ...base,
      provider: 'livekit',
      serviceCategory: PROVIDER_COST_CATEGORIES.sipTrunk,
      idempotencyKey: 'k3',
    });

    const categories = upsert.mock.calls.map(
      (call) => (call[0] as UpsertArgs).create.serviceCategory,
    );
    expect(categories).toEqual(['llm', 'agent_runtime', 'sip_trunk']);
  });

  it('does not write to the customer ledger', async () => {
    const { service, prisma } = makeService();

    await service.recordActualCost({
      organizationId: ORG,
      provider: 'livekit',
      serviceCategory: PROVIDER_COST_CATEGORIES.agentRuntime,
      idempotencyKey: 'k1',
      measuredUnit: 'minute',
      quantity: 1,
      amountUsd: 0.12,
      occurredAt: new Date(),
    });

    // Provider spend and customer credit are separate books; a cost correction
    // must never move a customer balance.
    expect(prisma).not.toHaveProperty('billingLedgerEntry');
    expect(prisma).not.toHaveProperty('organizationCreditBalance');
  });
});

describe('ProviderCostService.estimateMissingCallCosts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('estimates each finalized call that has no cost event', async () => {
    const { service, upsert } = makeService({
      callUsages: [
        {
          organizationId: ORG,
          workspaceId: 'ws-1',
          callId: 'call-a',
          provider: 'livekit',
          rawConnectedSeconds: 90,
          billableSeconds: 120,
          endedAt: new Date(),
          connectedAt: new Date(),
        },
        {
          organizationId: ORG,
          workspaceId: 'ws-1',
          callId: 'call-b',
          provider: 'livekit',
          rawConnectedSeconds: 0,
          billableSeconds: 60,
          endedAt: new Date(),
          connectedAt: new Date(),
        },
      ],
    });

    await expect(service.estimateMissingCallCosts(10)).resolves.toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('continues the batch when one row fails', async () => {
    const { service, upsert } = makeService({
      callUsages: [
        {
          organizationId: ORG,
          callId: 'call-a',
          provider: 'livekit',
          rawConnectedSeconds: 60,
          billableSeconds: 60,
          endedAt: new Date(),
          connectedAt: new Date(),
        },
        {
          organizationId: ORG,
          callId: 'call-b',
          provider: 'livekit',
          rawConnectedSeconds: 60,
          billableSeconds: 60,
          endedAt: new Date(),
          connectedAt: new Date(),
        },
      ],
    });
    upsert.mockRejectedValueOnce(new Error('unique violation'));

    await expect(service.estimateMissingCallCosts(10)).resolves.toBe(1);
  });
});

describe('ProviderCostService.costCoverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the share of finalized calls with no cost event', async () => {
    const { service } = makeService({ counts: [200, 4] });

    await expect(service.costCoverage(new Date())).resolves.toMatchObject({
      finalizedCalls: 200,
      callsMissingCost: 4,
      missingRatio: 0.02,
    });
  });

  it('reports zero missing when there is nothing to cover', async () => {
    const { service } = makeService({ counts: [0, 0] });

    // Guards against dividing by zero and paging on an idle system.
    await expect(service.costCoverage(new Date())).resolves.toMatchObject({ missingRatio: 0 });
  });
});
