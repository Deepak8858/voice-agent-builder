import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';

const existingCall = {
  id: 'call-existing',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  agentVersionId: 'version-1',
  direction: 'outbound',
  status: 'queued',
  provider: 'openai-realtime',
  providerCallId: 'provider-call-existing',
  fromNumber: null,
  toNumber: '+15551234567',
  contactName: null,
  durationSeconds: null,
  outcome: null,
  startedAt: new Date('2026-05-26T12:00:00.000Z'),
  endedAt: null,
  createdAt: new Date('2026-05-26T12:00:00.000Z'),
};

function makeService(options?: { routeFailure?: Error; windowCall?: { status: string } }) {
  const prisma = {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({
        organizationId: 'org-1',
        retentionDays: 365,
      })),
    },
    call: {
      // `windowCall` applies the real `status` predicate to one row inside the
      // 60s window, so a test can tell "no duplicate found" apart from "a
      // duplicate was found and returned".
      findFirst: options?.windowCall
        ? vi.fn(async ({ where }: { where: { status?: { notIn?: string[] } } }) => {
            const row = { ...existingCall, status: options.windowCall!.status };
            return (where.status?.notIn ?? []).includes(row.status) ? null : row;
          })
        : options?.routeFailure
          ? vi.fn(async () => null)
          : vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existingCall),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'call-new',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        agentVersionId: 'version-1',
        direction: 'outbound',
        status: 'queued',
        provider: 'openai-realtime',
        providerCallId: 'provider-call-new',
        fromNumber: null,
        toNumber: '+15551234567',
        contactName: null,
        durationSeconds: null,
        outcome: null,
        startedAt: new Date(),
        endedAt: null,
        createdAt: new Date(),
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...existingCall,
        id: 'call-new',
        ...data,
      })),
    },
    callUsage: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agent: {
      findFirst: vi.fn(async () => ({
        id: 'agent-1',
        status: 'published',
        activeVersionId: 'version-1',
        versions: [
          {
            id: 'version-1',
            providerRuntimeId: 'runtime-1',
            specJson: {},
          },
        ],
      })),
    },
  };
  const audit = { log: vi.fn(async () => undefined) };
  const voice = {
    name: 'openai-realtime',
    startOutboundCall: vi.fn(async () => ({
      provider_call_id: 'provider-call-new',
      status: 'queued',
    })),
    createAgent: vi.fn(async () => ({ provider_runtime_id: 'runtime-1' })),
  };
  const compliance = {
    check: vi.fn(async () => ({
      id: 'check-1',
      status: 'allowed',
      reasons: [],
      contact_id: null,
    })),
    attachCheckToCall: vi.fn(async () => undefined),
  };
  const analytics = { recordEventInternal: vi.fn(async () => undefined) };
  const billing = {
    checkFeatureGate: vi.fn(async () => true),
    canStartOutboundCall: vi.fn(async () => ({ allowed: true, remaining: 5, limit: 5 })),
  };
  const queue = { enqueue: vi.fn(async () => undefined) };
  const cache = {
    acquireLock: vi.fn(async () => Boolean(options?.routeFailure || options?.windowCall)),
    publish: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  };
  const admission = {
    admitCall: vi.fn(async () => ({
      admitted: true as const,
      leaseToken: 'lease-1',
      leaseExpiresAt: new Date().toISOString(),
      reservedSeconds: 60,
    })),
    compensate: vi.fn(async () => undefined),
    toError: vi.fn(() => new Error('denied')),
  };
  const service = new CallsService(
    prisma as never,
    audit as never,
    voice as never,
    {} as never,
    compliance as never,
    analytics as never,
    billing as never,
    queue as never,
    {} as never,
    cache as never,
    admission as never,
    { getEffectivePlan: vi.fn(async () => ({ plan: 'growth' })) } as never,
    undefined,
    options?.routeFailure
      ? ({
          route: vi.fn(() => {
            throw options.routeFailure;
          }),
        } as never)
      : undefined,
  );

  return { service, prisma, voice, cache, admission };
}

describe('CallsService.startOutboundCall idempotency', () => {
  it('returns the duplicate call and skips the voice provider when another request holds the dedupe lock', async () => {
    const { service, voice, cache } = makeService();

    const result = await service.startOutboundCall('ws-1', 'agent-1', 'user-1', {
      to_number: '+15551234567',
    });

    expect(cache.acquireLock).toHaveBeenCalled();
    expect(voice.startOutboundCall).not.toHaveBeenCalled();
    expect(result.id).toBe('call-existing');
  });

  it('marks a newly created call failed when pipeline routing rejects it', async () => {
    const { service, prisma, voice, admission } = makeService({
      routeFailure: new Error('routing unavailable'),
    });

    await expect(
      service.startOutboundCall('ws-1', 'agent-1', 'user-1', {
        to_number: '+15551234567',
      }),
    ).rejects.toThrow(/routing unavailable/);

    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-new' },
        data: expect.objectContaining({
          status: 'failed',
          outcome: 'pipeline_routing_failed',
          endedAt: expect.any(Date),
        }),
      }),
    );
    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(voice.startOutboundCall).not.toHaveBeenCalled();
  });

  /**
   * Admission reserves a minute of credit and takes a concurrency lease. A
   * request that short-circuits on the existing call must not do either, or a
   * double-click would charge the customer twice and hold a slot nothing ever
   * releases.
   */
  it('neither reserves credit nor takes a lease when it returns the duplicate call', async () => {
    const { service, admission, prisma } = makeService();

    await service.startOutboundCall('ws-1', 'agent-1', 'user-1', { to_number: '+15551234567' });

    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(admission.compensate).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });

  /**
   * A call that never connected is not a duplicate. Without a status predicate
   * the failed row is returned as if the dial had succeeded, so the caller is
   * told a call was placed that nobody is on, and cannot retry for a minute.
   */
  it('does not let a failed call in the window suppress a retry', async () => {
    const { service, voice, prisma } = makeService({ windowCall: { status: 'failed' } });

    const result = await service.startOutboundCall('ws-1', 'agent-1', 'user-1', {
      to_number: '+15551234567',
    });

    expect(voice.startOutboundCall).toHaveBeenCalledTimes(1);
    expect(prisma.call.create).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('call-new');
  });

  it('still suppresses a retry while an in_progress call to the same number is live', async () => {
    const { service, voice, prisma } = makeService({ windowCall: { status: 'in_progress' } });

    const result = await service.startOutboundCall('ws-1', 'agent-1', 'user-1', {
      to_number: '+15551234567',
    });

    expect(voice.startOutboundCall).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
    expect(result.id).toBe('call-existing');
  });
});
