import { describe, expect, it, beforeEach, vi } from 'vitest';
import { CallsService } from './calls.service';

interface CallRow {
  id: string;
  workspaceId: string;
  agentId: string;
  agentVersionId: string | null;
  startedAt: Date | null;
  status: string;
  providerCallId: string | null;
}

function makeService(opts: {
  callByProviderCallId?: CallRow | null;
  versionByRuntimeId?: {
    id: string;
    agentId: string;
    agent: { workspaceId: string };
  } | null;
}) {
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  const evals = vi.fn(async () => null);

  const prisma = {
    call: {
      findFirst: vi.fn(async () => opts.callByProviderCallId ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `c_${created.length + 1}`, ...data };
        created.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return { id: where.id, ...data };
      }),
    },
    callEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    agentVersion: {
      findFirst: vi.fn(async () => opts.versionByRuntimeId ?? null),
    },
  };
  const audit = { log: vi.fn() };
  const voice = { name: 'mock' };
  const evaluations = { evaluateCall: evals, getForCall: vi.fn() };
  const compliance = {
    check: vi.fn(),
    attachCheckToCall: vi.fn(),
    processTranscriptOptOut: vi.fn(async () => ({ opted_out: false })),
  };
  const analytics = { recordEventInternal: vi.fn(async () => undefined) };
  const service = new CallsService(
    prisma as never,
    audit as never,
    voice as never,
    evaluations as never,
    compliance as never,
    analytics as never,
  );
  return { service, prisma, created, updates, events, evals };
}

describe('CallsService.ingestEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-op when payload missing provider_call_id', async () => {
    const { service, prisma } = makeService({});
    await service.ingestEvent('vapi', { event_type: 'call.started' });
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });

  it('no-op when call.started arrives but provider_runtime_id unknown', async () => {
    const { service, created, events } = makeService({
      callByProviderCallId: null,
      versionByRuntimeId: null,
    });
    await service.ingestEvent('vapi', {
      event_type: 'call.started',
      provider_call_id: 'call_xyz',
      data: { provider_runtime_id: 'unknown_rt' },
    });
    expect(created).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('no-op for non-call.started events with unknown call', async () => {
    const { service, created, events } = makeService({ callByProviderCallId: null });
    await service.ingestEvent('vapi', {
      event_type: 'call.transcript_partial',
      provider_call_id: 'call_xyz',
    });
    expect(created).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('creates inbound Call row when call.started arrives for known provider_runtime_id', async () => {
    const { service, created, events } = makeService({
      callByProviderCallId: null,
      versionByRuntimeId: {
        id: 'v1',
        agentId: 'a1',
        agent: { workspaceId: 'w1' },
      },
    });
    await service.ingestEvent('vapi', {
      event_type: 'call.started',
      provider_call_id: 'call_xyz',
      data: {
        provider_runtime_id: 'mock_rt_42',
        from_number: '+15550001111',
        to_number: '+18004443333',
        contact_name: 'John',
        started_at: '2026-01-01T00:00:00Z',
      },
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      direction: 'inbound',
      status: 'in_progress',
      provider: 'vapi',
      workspaceId: 'w1',
      agentId: 'a1',
      agentVersionId: 'v1',
      fromNumber: '+15550001111',
      toNumber: '+18004443333',
      contactName: 'John',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'call.started' });
  });

  it('on call.ended persists transcript/recording/outcome and triggers evaluation', async () => {
    const { service, updates, evals } = makeService({
      callByProviderCallId: {
        id: 'c1',
        workspaceId: 'w1',
        agentId: 'a1',
        agentVersionId: 'v1',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'in_progress',
        providerCallId: 'call_xyz',
      },
    });
    await service.ingestEvent('vapi', {
      event_type: 'call.ended',
      provider_call_id: 'call_xyz',
      data: {
        transcript: 'agent: hello\ncaller: hi',
        recording_url: 'https://rec/1.mp3',
        outcome: 'completed',
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({
      status: 'completed',
      transcriptText: 'agent: hello\ncaller: hi',
      recordingUrl: 'https://rec/1.mp3',
      outcome: 'completed',
    });
    expect(evals).toHaveBeenCalledWith('c1');
  });

  it('evaluation failure does not break webhook', async () => {
    const { service, updates } = makeService({
      callByProviderCallId: {
        id: 'c1',
        workspaceId: 'w1',
        agentId: 'a1',
        agentVersionId: 'v1',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'in_progress',
        providerCallId: 'call_xyz',
      },
    });
    // Force evaluation to throw by reaching into the private member.
    (service as unknown as { evaluations: { evaluateCall: () => Promise<never> } }).evaluations.evaluateCall =
      async () => {
        throw new Error('eval boom');
      };
    await expect(
      service.ingestEvent('vapi', {
        event_type: 'call.ended',
        provider_call_id: 'call_xyz',
        data: {},
      }),
    ).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
  });

  it('intermediate event for known call appends to call_events without status change', async () => {
    const { service, updates, events } = makeService({
      callByProviderCallId: {
        id: 'c1',
        workspaceId: 'w1',
        agentId: 'a1',
        agentVersionId: 'v1',
        startedAt: new Date(),
        status: 'in_progress',
        providerCallId: 'call_xyz',
      },
    });
    await service.ingestEvent('vapi', {
      event_type: 'agent.booking_created',
      provider_call_id: 'call_xyz',
      data: { booking_id: 'b1' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'agent.booking_created' });
    expect(updates).toHaveLength(0);
  });
});
