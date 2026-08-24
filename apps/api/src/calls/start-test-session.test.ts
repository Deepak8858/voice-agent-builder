import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';

function makeService(overrides?: {
  voice?: Record<string, unknown>;
  prisma?: Record<string, unknown>;
  admission?: Record<string, unknown>;
  entitlements?: Record<string, unknown>;
  livekit?: Record<string, unknown>;
  /** Supply a router + LiveKit so the in-house pipeline path is reachable. */
  standardPipeline?: boolean;
  plan?: string;
  /** Mirrors VOICE_STANDARD_PIPELINE_ENABLED=false for the routed plan. */
  standardPipelineDisabled?: boolean;
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
      update: vi.fn(async () => ({ id: 'call-1' })),
    },
    callUsage: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    ...(overrides?.prisma ?? {}),
  };

  const audit = { log: vi.fn(async () => undefined) };
  const voice = {
    name: 'openai-realtime',
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
      current: 600,
      limit: 60,
    })),
    getEffectivePlan: vi.fn(async () => ({ plan: overrides?.plan ?? 'free' })),
    ...(overrides?.entitlements ?? {}),
  };

  const admission = {
    admitCall: vi.fn(async () => ({
      admitted: true as const,
      leaseToken: 'lease-1',
      leaseExpiresAt: '2026-05-30T00:05:00.000Z',
      reservedSeconds: 60,
    })),
    compensate: vi.fn(async () => undefined),
    toError: vi.fn((denial: { message: string }) => new Error(denial.message)),
    ...(overrides?.admission ?? {}),
  };

  // Mirrors PipelineRouterService for the plans under test: free is entitled
  // only to the in-house pipeline, which is what routes a free browser test away
  // from the Realtime runtime, and paid plans here are realtime-only. The
  // `standard_pipeline_disabled` reason is what the service turns into a refusal
  // rather than a silent upgrade to the runtime the plan does not pay for.
  const pipelineRouter = {
    route: vi.fn((plan: string) =>
      plan === 'free'
        ? {
            pipeline: 'standard' as const,
            reason: overrides?.standardPipelineDisabled
              ? ('standard_pipeline_disabled' as const)
              : ('plan_standard_only' as const),
          }
        : { pipeline: 'realtime' as const, reason: 'plan_realtime_only' as const },
    ),
    isAllowed: vi.fn((plan: string) => plan !== 'free'),
    standardPipelineEnabled: vi.fn(() => !overrides?.standardPipelineDisabled),
  };
  const livekit = {
    livekitUrl: 'wss://livekit.example.test',
    createRoomForCall: vi.fn(async () => undefined),
    dispatchAgent: vi.fn(async () => undefined),
    createAccessToken: vi.fn(async () => 'livekit-token-1'),
    ...(overrides?.livekit ?? {}),
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
    admission as never,
    entitlements as never,
    undefined,
    overrides?.standardPipeline ? (pipelineRouter as never) : undefined,
    overrides?.standardPipeline ? (livekit as never) : undefined,
  );

  return { service, prisma, audit, voice, entitlements, admission, pipelineRouter, livekit };
}

describe('CallsService.startTestSession', () => {
  it('keeps a live browser test session instead of failing when the transcript is not ready yet', async () => {
    const { service, prisma, voice } = makeService({
      voice: {
        getTranscript: vi.fn(async () => {
          throw new Error('Voice provider error 500 on GET /call/test-session-1/transcript');
        }),
      },
    });

    const result = await service.startTestSession('workspace-1', 'agent-1', 'user-1', {
      contact_name: 'Browser tester',
    });

    expect(result).toMatchObject({
      call_id: 'call-1',
      test_session_id: 'test-session-1',
      web_socket_url: 'wss://voice.example.test/session',
      token: 'token-1',
    });
    expect(voice.getTranscript).toHaveBeenCalledWith({ callId: 'test-session-1' });
    // The readiness decision is made on the post-session update, so that is
    // where "still live" has to be asserted: a missing transcript must not mark
    // the call completed with a zero duration.
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
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

  /**
   * A browser test spends the organization's minutes, so an unfunded one is
   * refused before any runtime is engaged rather than after a session exists
   * that we would then have to tear down.
   */
  it('checks funding for the minimum billable minute before the provider session is created', async () => {
    const { service, entitlements, voice } = makeService();

    await service.startTestSession('workspace-1', 'agent-1', 'user-1', {
      contact_name: 'Browser tester',
    });

    expect(entitlements.assertAllowed).toHaveBeenCalledWith('org-1', {
      kind: 'browser_test',
      minimumSeconds: 60,
    });
    expect(entitlements.assertAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      voice.createBrowserTestSession.mock.invocationCallOrder[0]!,
    );
  });

  it('admits a Realtime browser test before creating the provider session', async () => {
    const { service, admission, voice } = makeService();

    await service.startTestSession('workspace-1', 'agent-1', 'user-1', {
      contact_name: 'Browser tester',
    });

    expect(admission.admitCall).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        callId: 'call-1',
        direction: 'browser_test',
        pipeline: 'realtime',
      }),
    );
    expect(admission.admitCall.mock.invocationCallOrder[0]).toBeLessThan(
      voice.createBrowserTestSession.mock.invocationCallOrder[0]!,
    );
  });

  it('compensates the Realtime reservation when provider session creation fails', async () => {
    const { service, admission, prisma } = makeService({
      voice: {
        createBrowserTestSession: vi.fn(async () => {
          throw new Error('realtime unavailable');
        }),
      },
    });

    await expect(
      service.startTestSession('workspace-1', 'agent-1', 'user-1', {
        contact_name: 'Browser tester',
      }),
    ).rejects.toThrow(/realtime unavailable/);

    expect(admission.compensate).toHaveBeenCalledWith(
      'org-1',
      'call-1',
      'provider_dispatch_failed',
    );
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          outcome: 'provider_dispatch_failed',
        }),
      }),
    );
  });

  it('does not reach the voice provider when the monthly allowance is spent', async () => {
    const { service, entitlements, voice, prisma } = makeService();
    entitlements.assertAllowed.mockRejectedValue(
      new Error('Your organization has used its free minutes for this month.'),
    );

    await expect(
      service.startTestSession('workspace-1', 'agent-1', 'user-1', {
        contact_name: 'Browser tester',
      }),
    ).rejects.toThrow(/free minutes for this month/);

    expect(voice.createBrowserTestSession).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });

  describe('in-house pipeline', () => {
    /**
     * Free credits fund the cheap runtime only, so a free test joins a LiveKit
     * room instead of minting a Realtime client secret.
     */
    it('routes a Free browser test to LiveKit instead of the Realtime runtime', async () => {
      const { service, voice, livekit, prisma } = makeService({ standardPipeline: true });

      const result = await service.startTestSession('workspace-1', 'agent-1', 'user-1', {
        contact_name: 'Browser tester',
      });

      expect(result).toMatchObject({
        call_id: 'call-1',
        pipeline: 'standard',
        livekit_url: 'wss://livekit.example.test',
        room_name: 'call-test-call-1',
        token: 'livekit-token-1',
        web_socket_url: null,
      });
      expect(voice.createBrowserTestSession).not.toHaveBeenCalled();
      expect(livekit.dispatchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ pipeline: 'standard' }) }),
      );
      expect(prisma.call.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ pipeline: 'standard' }) }),
      );
    });

    /**
     * Admission is what reserves the first minute and creates the `CallUsage`
     * row the worker commits against. Skipping it would let the test start and
     * then be hung up as unmetered once the runtime failed to find a
     * reservation, so it must run before the room is dispatched.
     */
    it('admits the test as a metered call before dispatching the room', async () => {
      const { service, admission, livekit } = makeService({ standardPipeline: true });

      await service.startTestSession('workspace-1', 'agent-1', 'user-1', {
        contact_name: 'Browser tester',
      });

      expect(admission.admitCall).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          callId: 'call-1',
          direction: 'browser_test',
          pipeline: 'standard',
        }),
      );
      expect(admission.admitCall.mock.invocationCallOrder[0]).toBeLessThan(
        livekit.createRoomForCall.mock.invocationCallOrder[0]!,
      );
    });

    it('fails the call and never dispatches when admission refuses it', async () => {
      const { service, livekit, prisma } = makeService({
        standardPipeline: true,
        admission: {
          admitCall: vi.fn(async () => ({
            admitted: false as const,
            reason: 'credit_insufficient' as const,
            message: 'no minutes',
          })),
        },
      });

      await expect(
        service.startTestSession('workspace-1', 'agent-1', 'user-1', {
          contact_name: 'Browser tester',
        }),
      ).rejects.toThrow(/no minutes/);

      expect(livekit.createRoomForCall).not.toHaveBeenCalled();
      expect(prisma.call.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'call-1' },
          data: expect.objectContaining({ status: 'failed', outcome: 'credit_insufficient' }),
        }),
      );
    });

    /** A room that never came up owes nothing, so the reserved minute goes back. */
    it('returns the reserved minute when the room cannot be dispatched', async () => {
      const { service, admission, prisma } = makeService({
        standardPipeline: true,
        livekit: {
          dispatchAgent: vi.fn(async () => {
            throw new Error('livekit unavailable');
          }),
        },
      });

      await expect(
        service.startTestSession('workspace-1', 'agent-1', 'user-1', {
          contact_name: 'Browser tester',
        }),
      ).rejects.toThrow(/livekit unavailable/);

      expect(admission.compensate).toHaveBeenCalledWith(
        'org-1',
        'call-1',
        'provider_dispatch_failed',
      );
      expect(prisma.call.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            outcome: 'provider_dispatch_failed',
          }),
        }),
      );
    });

    it('returns the reserved minute when browser access-token creation fails', async () => {
      const { service, admission, prisma } = makeService({
        standardPipeline: true,
        livekit: {
          createAccessToken: vi.fn(async () => {
            throw new Error('token signing unavailable');
          }),
        },
      });

      await expect(
        service.startTestSession('workspace-1', 'agent-1', 'user-1', {
          contact_name: 'Browser tester',
        }),
      ).rejects.toThrow(/token signing unavailable/);

      expect(admission.compensate).toHaveBeenCalledWith(
        'org-1',
        'call-1',
        'provider_dispatch_failed',
      );
      expect(prisma.call.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            outcome: 'provider_dispatch_failed',
          }),
        }),
      );
    });

    /**
     * Reconciliation joins provider records to usage rows by provider call id,
     * and for an in-house test that identifier is the room, which only exists
     * after admission has already created the usage row.
     */
    it('back-fills the room name onto the usage row for reconciliation', async () => {
      const { service, prisma } = makeService({ standardPipeline: true });

      await service.startTestSession('workspace-1', 'agent-1', 'user-1', {
        contact_name: 'Browser tester',
      });

      expect(prisma.callUsage.updateMany).toHaveBeenCalledWith({
        where: { callId: 'call-1' },
        data: { providerCallId: 'call-test-call-1' },
      });
    });

    it('keeps a paid organization on the Realtime runtime', async () => {
      const { service, voice, livekit } = makeService({
        standardPipeline: true,
        plan: 'growth',
      });

      await expect(
        service.startTestSession('workspace-1', 'agent-1', 'user-1', {
          contact_name: 'Browser tester',
        }),
      ).resolves.toMatchObject({ pipeline: 'realtime' });

      expect(voice.createBrowserTestSession).toHaveBeenCalled();
      expect(livekit.createRoomForCall).not.toHaveBeenCalled();
    });

    /**
     * A Free plan has no realtime entitlement, so when the in-house pipeline is
     * switched off it has no runtime at all. Refusing is the only honest answer:
     * falling back to Realtime would hand the expensive runtime to the tier that
     * does not pay for it.
     */
    it('refuses a Free test instead of upgrading it when the in-house pipeline is off', async () => {
      const { service, voice, livekit, prisma } = makeService({
        standardPipeline: true,
        standardPipelineDisabled: true,
      });

      await expect(
        service.startTestSession('workspace-1', 'agent-1', 'user-1', {
          contact_name: 'Browser tester',
        }),
      ).rejects.toThrow(/temporarily unavailable/i);

      expect(voice.createBrowserTestSession).not.toHaveBeenCalled();
      expect(livekit.createRoomForCall).not.toHaveBeenCalled();
      expect(prisma.call.create).not.toHaveBeenCalled();
    });
  });
});
