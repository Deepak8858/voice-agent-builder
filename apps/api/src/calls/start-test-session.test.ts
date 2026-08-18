import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';

function makeService(overrides?: {
  voice?: Record<string, unknown>;
  prisma?: Record<string, unknown>;
}) {
  const prisma = {
    agent: {
      findFirst: vi.fn(async () => ({
        id: 'agent-1',
        activeVersionId: 'version-1',
        versions: [
          {
            id: 'version-1',
            specJson: { name: 'Test Agent' },
            providerRuntimeId: 'runtime-1',
          },
        ],
      })),
    },
    agentVersion: {
      findUnique: vi.fn(async () => ({ providerRuntimeId: 'runtime-1' })),
      update: vi.fn(),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({
        organizationId: 'org-1',
        retentionDays: 30,
      })),
    },
    trialRedemption: {
      create: vi.fn(async () => ({ id: 'trial-1' })),
    },
    call: {
      create: vi.fn(async (args) => ({
        id: 'call-1',
        workspaceId: args.data.workspaceId,
        agentId: args.data.agentId,
        agentVersionId: args.data.agentVersionId,
        direction: args.data.direction,
        status: args.data.status,
        provider: args.data.provider,
        fromNumber: null,
        toNumber: null,
        contactName: args.data.contactName,
        durationSeconds: args.data.durationSeconds,
        outcome: args.data.outcome,
        startedAt: args.data.startedAt,
        endedAt: args.data.endedAt,
        createdAt: new Date('2026-05-30T00:00:00.000Z'),
      })),
    },
    ...(overrides?.prisma ?? {}),
  };

  const audit = { log: vi.fn(async () => undefined) };
  const voice = {
    name: 'vapi',
    createBrowserTestSession: vi.fn(async () => ({
      test_session_id: 'test-session-1',
      web_socket_url: 'wss://voice.example.test/session',
      token: 'token-1',
      expires_at: '2026-05-30T00:15:00.000Z',
    })),
    getTranscript: vi.fn(async () => ({
      transcript: 'agent: Hello',
      turns: [{ speaker: 'agent', text: 'Hello', at_ms: 1000 }],
    })),
    ...(overrides?.voice ?? {}),
  };

  const entitlements = {
    assertAllowed: vi.fn(async () => ({
      allowed: true as const,
      reason: 'allowed' as const,
      limit: 180,
    })),
  };

  const service = new CallsService(
    prisma as never,
    audit as never,
    voice as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { del: vi.fn(async () => undefined) } as never,
    {} as never,
    entitlements as never,
  );

  return { service, prisma, audit, voice, entitlements };
}

describe('CallsService.startTestSession', () => {
  it('keeps a live browser test session instead of failing when the transcript is not ready yet', async () => {
    const { service, prisma, voice } = makeService({
      voice: {
        getTranscript: vi.fn(async () => {
          throw new Error('Vapi API error 500 on GET /call/test-session-1/transcript');
        }),
      },
    });

    const result = await service.startTestSession(
      'workspace-1',
      'agent-1',
      'user-1',
      { contact_name: 'Browser tester' },
    );

    expect(result).toMatchObject({
      call_id: 'call-1',
      test_session_id: 'test-session-1',
      web_socket_url: 'wss://voice.example.test/session',
      token: 'token-1',
    });
    expect(voice.getTranscript).toHaveBeenCalledWith({ callId: 'test-session-1' });
    expect(prisma.call.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'in_progress',
          endedAt: null,
          durationSeconds: null,
          transcriptText: '',
          outcome: null,
        }),
      }),
    );
  });

  it('claims the lifetime trial before the provider session is created', async () => {
    const { service, prisma, entitlements, voice } = makeService();

    await service.startTestSession('workspace-1', 'agent-1', 'user-1', {
      contact_name: 'Browser tester',
    });

    expect(entitlements.assertAllowed).toHaveBeenCalledWith('org-1', { kind: 'browser_test' });
    expect(entitlements.assertAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      voice.createBrowserTestSession.mock.invocationCallOrder[0]!,
    );
    expect(prisma.trialRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-1',
          callId: 'call-1',
          maxDurationSeconds: 180,
          disposition: 'claimed',
        }),
      }),
    );
  });

  it('does not reach the voice provider when the trial is already spent', async () => {
    const { service, entitlements, voice, prisma } = makeService();
    entitlements.assertAllowed.mockRejectedValue(new Error('trial already used'));

    await expect(
      service.startTestSession('workspace-1', 'agent-1', 'user-1', {
        contact_name: 'Browser tester',
      }),
    ).rejects.toThrow(/trial already used/);

    expect(voice.createBrowserTestSession).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });
});
