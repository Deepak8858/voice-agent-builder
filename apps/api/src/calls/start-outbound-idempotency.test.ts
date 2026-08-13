import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';

const existingCall = {
  id: 'call-existing',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  agentVersionId: 'version-1',
  direction: 'outbound',
  status: 'queued',
  provider: 'vapi',
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

function makeService() {
  const prisma = {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({
        organizationId: 'org-1',
        retentionDays: 365,
      })),
    },
    call: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingCall),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'call-new',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        agentVersionId: 'version-1',
        direction: 'outbound',
        status: 'queued',
        provider: 'vapi',
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
    name: 'vapi',
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
    acquireLock: vi.fn(async () => false),
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
    {} as never,
  );

  return { service, prisma, voice, cache };
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
});
