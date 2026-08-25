import { describe, expect, it, vi } from 'vitest';
import { ForbiddenPlanError } from '../billing/billing.service';
import { ComplianceBlockedError } from '../common/errors';
import { TelephonyService } from './telephony.service';

function makeAdmission() {
  return {
    admitCall: vi.fn(async () => ({
      admitted: true as const,
      leaseToken: 'lease-1',
      leaseExpiresAt: new Date('2026-06-07T10:01:00.000Z').toISOString(),
      reservedSeconds: 60,
    })),
    compensate: vi.fn(async () => undefined),
    releaseLease: vi.fn(async () => undefined),
    finalizeUsage: vi.fn(async () => undefined),
    toError: vi.fn(() => new Error('denied')),
  };
}

const INBOUND_VOICE_PAYLOAD = { CallSid: 'CA123', From: '+14155559876', To: '+14155551234' };
const INBOUND_VOICE_REQUEST = {
  headers: { 'x-twilio-signature': 'good-signature' },
  url: 'https://vocal.devdeepak.me/api/v1/telephony/twilio/voice/number-1',
};

/**
 * A signature-valid inbound Twilio voice webhook for a fully configured
 * LiveKit number, so each test only has to vary the billing decision and
 * whether the delivery is a retry.
 */
function makeInboundVoiceService(overrides?: {
  admitted?: boolean;
  existingCall?: unknown;
  existingUsage?: unknown;
}) {
  const prisma = {
    telephonyPhoneNumber: {
      findUnique: vi.fn(async () => ({
        id: 'number-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        provider: 'twilio',
        phoneNumberE164: '+14155551234',
        assignedAgentId: 'agent-1',
        assignedAgent: { id: 'agent-1' },
        livekitConfig: { livekitSipHost: 'tenant.sip.livekit.cloud' },
        providerConnection: { encryptedCredentials: { encrypted: true } },
        providerMetadata: null,
      })),
    },
    telephonyWebhookEvent: {
      create: vi.fn(async () => ({ id: 'event-1' })),
    },
    call: {
      upsert: vi.fn(
        async () =>
          overrides?.existingCall ?? {
            id: 'call-1',
            workspaceId: 'workspace-1',
            organizationId: 'org-1',
            agentId: 'agent-1',
            phoneNumberId: 'number-1',
          },
      ),
      update: vi.fn(async () => ({ id: 'call-1' })),
    },
    callUsage: {
      findUnique: vi.fn(async () => overrides?.existingUsage ?? null),
    },
  };
  const admitted = overrides?.admitted ?? true;
  const admission = {
    ...makeAdmission(),
    admitCall: vi.fn(async () =>
      admitted
        ? {
            admitted: true as const,
            leaseToken: 'lease-1',
            leaseExpiresAt: new Date('2026-06-07T10:01:00.000Z').toISOString(),
            reservedSeconds: 60,
          }
        : {
            admitted: false as const,
            reason: 'credit_insufficient' as const,
            message: 'No credit.',
          },
    ),
  };
  const twilioFallback = {
    buildFallbackTwiml: vi.fn(() => '<Response><Say>Unavailable</Say><Hangup/></Response>'),
    buildBillingRefusalTwiml: vi.fn(
      () => '<Response><Say>Cannot take calls</Say><Hangup/></Response>',
    ),
    buildLiveKitDialTwiml: vi.fn(
      () => '<Response><Dial><Sip>sip:tenant.sip.livekit.cloud</Sip></Dial></Response>',
    ),
  };
  const service = new TelephonyService(
    prisma as never,
    {} as never,
    { adapterFor: vi.fn(() => ({ validateWebhookSignature: vi.fn(async () => true) })) } as never,
    {
      encryptJson: vi.fn(),
      decryptJson: vi.fn(() => ({
        provider: 'twilio',
        accountSid: 'AC123',
        authToken: 'auth-token',
      })),
    } as never,
    { log: vi.fn(async () => undefined) } as never,
    {} as never,
    {} as never,
    twilioFallback as never,
    admission as never,
  );

  return { service, prisma, admission, twilioFallback };
}

function makePrisma() {
  return {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: 'workspace-1',
        organizationId: 'org-1',
        retentionDays: 30,
      })),
    },
    telephonyPhoneNumber: {
      findFirst: vi.fn(async () => ({
        id: 'number-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        provider: 'twilio',
        phoneNumberE164: '+14155551234',
        assignedAgentId: 'agent-1',
        inboundEnabled: true,
        outboundEnabled: true,
        livekitConfig: { outboundTrunkId: 'trunk-out-1' },
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'number-1',
        ...data,
      })),
    },
    call: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'call-1',
        ...data,
      })),
      findFirst: vi.fn(),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'call-1',
        ...data,
      })),
    },
    callUsage: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agent: {
      findFirst: vi.fn(async () => ({
        id: 'agent-1',
        workspaceId: 'workspace-1',
        name: 'Sales Agent',
        activeVersionId: 'version-1',
      })),
    },
    liveKitTelephonyConfig: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => ({
          id: 'lk-config-1',
          ...create,
          ...update,
        }),
      ),
    },
  };
}

describe('TelephonyService', () => {
  it('configures LiveKit for a workspace-owned phone number and assigned agent', async () => {
    const prisma = makePrisma();
    const livekit = {
      createInboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-in-1' })),
      createOutboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-out-1' })),
      createDispatchRule: vi.fn(async () => ({ dispatchRuleId: 'dispatch-1' })),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const registry = {
      adapterFor: vi.fn(() => ({
        configureInboundRouting: vi.fn(async () => ({ status: 'configured' })),
      })),
    };
    const audit = { log: vi.fn(async () => undefined) };
    const billing = {
      checkFeatureGate: vi.fn(async () => true),
      canStartOutboundCall: vi.fn(async () => ({ allowed: true, remaining: 10, limit: 100 })),
    };
    const compliance = {
      check: vi.fn(async () => ({
        id: 'check-1',
        status: 'passed',
        reasons: [],
        contact_id: null,
      })),
      attachCheckToCall: vi.fn(async () => undefined),
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      registry as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      audit as never,
      billing as never,
      compliance as never,
      {} as never,
      makeAdmission() as never,
    );

    const result = await service.configureLiveKit('workspace-1', 'number-1', 'user-1');

    expect(result.status).toBe('configured');
    expect(livekit.createInboundSipTrunk).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        phoneNumberId: 'number-1',
        phoneNumberE164: '+14155551234',
        provider: 'twilio',
      }),
    );
    expect(livekit.createDispatchRule).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        phoneNumberId: 'number-1',
        agentId: 'agent-1',
        trunkId: 'trunk-in-1',
        agentName: 'voiceforge-agent',
        metadata: expect.objectContaining({ model: 'gpt-realtime-2' }),
      }),
    );
    expect(prisma.liveKitTelephonyConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { phoneNumberId: 'number-1' },
        create: expect.objectContaining({
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          phoneNumberId: 'number-1',
          agentId: 'agent-1',
          inboundTrunkId: 'trunk-in-1',
          outboundTrunkId: 'trunk-out-1',
          dispatchRuleId: 'dispatch-1',
          status: 'configured',
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        actorUserId: 'user-1',
        action: 'telephony.livekit.configure',
        resourceType: 'telephony_phone_number',
        resourceId: 'number-1',
      }),
    );
  });

  it('blocks outbound LiveKit calls before creating a SIP participant when compliance fails', async () => {
    const prisma = makePrisma();
    const livekit = {
      createOutboundCall: vi.fn(async () => ({
        providerCallId: 'participant-1',
        roomName: 'room-1',
        status: 'queued',
      })),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const audit = { log: vi.fn(async () => undefined) };
    const billing = {
      checkFeatureGate: vi.fn(async () => true),
      canStartOutboundCall: vi.fn(async () => ({ allowed: true, remaining: 10, limit: 100 })),
    };
    const compliance = {
      check: vi.fn(async () => ({
        id: 'check-1',
        status: 'blocked',
        reasons: [{ code: 'dnc_listed', message: 'Do not call.', severity: 'blocking' }],
        contact_id: null,
      })),
      attachCheckToCall: vi.fn(async () => undefined),
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      audit as never,
      billing as never,
      compliance as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.startOutboundCall('workspace-1', 'user-1', {
        phone_number_id: 'number-1',
        to_number: '+14155559876',
        metadata: { purpose: 'appointment_reminder' },
      }),
    ).rejects.toBeInstanceOf(ComplianceBlockedError);

    expect(compliance.check).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        direction: 'outbound',
        toNumber: '+14155559876',
        purpose: 'appointment_reminder',
      }),
    );
    expect(livekit.createOutboundCall).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'telephony.outbound_call.blocked',
        resourceType: 'compliance_check',
        resourceId: 'check-1',
      }),
    );
  });

  it('dispatches the generic LiveKit voice agent for outbound calls and passes the assigned agent id in metadata', async () => {
    const prisma = makePrisma();
    const livekit = {
      createOutboundCall: vi.fn(async () => ({
        providerCallId: 'participant-1',
        roomName: 'room-1',
        status: 'queued',
      })),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const audit = { log: vi.fn(async () => undefined) };
    const billing = {
      checkFeatureGate: vi.fn(async () => true),
      canStartOutboundCall: vi.fn(async () => ({ allowed: true, remaining: 10, limit: 100 })),
    };
    const compliance = {
      check: vi.fn(async () => ({
        id: 'check-1',
        status: 'passed',
        reasons: [],
        contact_id: 'contact-1',
      })),
      attachCheckToCall: vi.fn(async () => undefined),
    };
    const admission = makeAdmission();
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      audit as never,
      billing as never,
      compliance as never,
      {} as never,
      admission as never,
    );

    await service.startOutboundCall('workspace-1', 'user-1', {
      phone_number_id: 'number-1',
      to_number: '+14155559876',
      metadata: { purpose: 'outbound_campaign' },
    });

    expect(admission.admitCall).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        callId: 'call-1',
        direction: 'outbound',
      }),
    );
    expect(admission.compensate).not.toHaveBeenCalled();

    expect(livekit.createOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        agentName: 'voiceforge-agent',
        metadata: expect.objectContaining({
          workspaceId: 'workspace-1',
          phoneNumberId: 'number-1',
          provider: 'twilio',
          purpose: 'outbound_campaign',
        }),
      }),
    );
  });

  it('uses the same routed pipeline for persistence, admission, and LiveKit dispatch', async () => {
    const prisma = makePrisma();
    const livekit = {
      createOutboundCall: vi.fn(async () => ({
        providerCallId: 'participant-1',
        roomName: 'room-1',
        status: 'queued',
      })),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const admission = makeAdmission();
    const pipelineRouter = {
      route: vi.fn(() => ({
        pipeline: 'standard' as const,
        reason: 'plan_standard_only' as const,
      })),
    };
    const entitlements = { getEffectivePlan: vi.fn(async () => ({ plan: 'free' })) };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      { checkFeatureGate: vi.fn(async () => true) } as never,
      {
        check: vi.fn(async () => ({
          id: 'check-1',
          status: 'passed',
          reasons: [],
          contact_id: null,
        })),
        attachCheckToCall: vi.fn(async () => undefined),
      } as never,
      {} as never,
      admission as never,
      pipelineRouter as never,
      entitlements as never,
    );

    await service.startOutboundCall('workspace-1', 'user-1', {
      phone_number_id: 'number-1',
      to_number: '+14155559876',
    });

    expect(prisma.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { pipeline: 'standard' },
    });
    expect(admission.admitCall).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: 'standard' }),
    );
    expect(livekit.createOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ pipeline: 'standard' }) }),
    );
  });

  it('marks the call failed when pipeline routing rejects it', async () => {
    const prisma = makePrisma();
    const livekit = { createOutboundCall: vi.fn(), livekitSipHost: 'tenant.sip.livekit.cloud' };
    const admission = makeAdmission();
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      { checkFeatureGate: vi.fn(async () => true) } as never,
      {
        check: vi.fn(async () => ({
          id: 'check-1',
          status: 'passed',
          reasons: [],
          contact_id: null,
        })),
        attachCheckToCall: vi.fn(async () => undefined),
      } as never,
      {} as never,
      admission as never,
      {
        route: vi.fn(() => {
          throw new Error('routing unavailable');
        }),
      } as never,
      { getEffectivePlan: vi.fn(async () => ({ plan: 'growth' })) } as never,
    );

    await expect(
      service.startOutboundCall('workspace-1', 'user-1', {
        phone_number_id: 'number-1',
        to_number: '+14155559876',
      }),
    ).rejects.toThrow(/routing unavailable/);

    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({
          status: 'failed',
          outcome: 'pipeline_routing_failed',
          endedAt: expect.any(Date),
        }),
      }),
    );
    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(livekit.createOutboundCall).not.toHaveBeenCalled();
  });

  it('blocks free workspaces from using BYO LiveKit outbound calling', async () => {
    const prisma = makePrisma();
    const livekit = {
      createOutboundCall: vi.fn(async () => ({
        providerCallId: 'participant-1',
        roomName: 'room-1',
        status: 'queued',
      })),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const billing = {
      checkFeatureGate: vi.fn(async (organizationId: string, gate: string) => {
        expect(organizationId).toBe('org-1');
        return gate !== 'byo_telephony';
      }),
      canStartOutboundCall: vi.fn(async () => ({ allowed: true, remaining: 10, limit: 100 })),
    };
    const compliance = {
      check: vi.fn(),
      attachCheckToCall: vi.fn(),
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      billing as never,
      compliance as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.startOutboundCall('workspace-1', 'user-1', {
        phone_number_id: 'number-1',
        to_number: '+14155559876',
        metadata: { purpose: 'appointment_reminder' },
      }),
    ).rejects.toThrow(/VoiceForge voice pipeline only/);

    expect(compliance.check).not.toHaveBeenCalled();
    expect(livekit.createOutboundCall).not.toHaveBeenCalled();
  });

  it('returns plan upgrade details when BYO LiveKit calling is blocked on free plan', async () => {
    const prisma = makePrisma();
    const livekit = {
      createOutboundCall: vi.fn(async () => ({
        providerCallId: 'participant-1',
        roomName: 'room-1',
        status: 'queued',
      })),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const billing = {
      checkFeatureGate: vi.fn(
        async (_organizationId: string, gate: string) => gate !== 'byo_telephony',
      ),
      canStartOutboundCall: vi.fn(async () => ({ allowed: true, remaining: 10, limit: 100 })),
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      billing as never,
      { check: vi.fn(), attachCheckToCall: vi.fn() } as never,
      {} as never,
      makeAdmission() as never,
    );

    let thrown: unknown;
    try {
      await service.startOutboundCall('workspace-1', 'user-1', {
        phone_number_id: 'number-1',
        to_number: '+14155559876',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ForbiddenPlanError);
    expect((thrown as ForbiddenPlanError).details).toEqual({
      limitType: 'byo_telephony',
      currentPlan: 'free',
      upgradePath: '/dashboard/billing',
    });
    expect((thrown as ForbiddenPlanError).getResponse()).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: {
        limitType: 'byo_telephony',
        currentPlan: 'free',
        upgradePath: '/dashboard/billing',
      },
    });
    expect(livekit.createOutboundCall).not.toHaveBeenCalled();
  });

  it('rejects Twilio voice webhooks with invalid signatures before creating an inbound call', async () => {
    const prisma = {
      telephonyPhoneNumber: {
        findUnique: vi.fn(async () => ({
          id: 'number-1',
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          provider: 'twilio',
          providerConnectionId: 'connection-1',
          phoneNumberE164: '+14155551234',
          assignedAgentId: 'agent-1',
          assignedAgent: { id: 'agent-1' },
          livekitConfig: { livekitSipHost: 'tenant.sip.livekit.cloud' },
          providerConnection: {
            encryptedCredentials: { encrypted: true },
          },
          providerMetadata: null,
        })),
      },
      call: {
        create: vi.fn(),
        findFirst: vi.fn(),
      },
    };
    const signatureAdapter = {
      validateWebhookSignature: vi.fn(async () => false),
    };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn(() => signatureAdapter) } as never,
      {
        encryptJson: vi.fn(),
        decryptJson: vi.fn(() => ({
          provider: 'twilio',
          accountSid: 'AC123',
          authToken: 'auth-token',
        })),
      } as never,
      { log: vi.fn() } as never,
      {} as never,
      {} as never,
      {
        buildFallbackTwiml: vi.fn(() => '<Response><Hangup/></Response>'),
        buildLiveKitDialTwiml: vi.fn(
          () => '<Response><Dial><Sip>sip:tenant.sip.livekit.cloud</Sip></Dial></Response>',
        ),
      } as never,
      makeAdmission() as never,
    );

    await expect(
      service.handleTwilioVoice(
        'number-1',
        { CallSid: 'CA123', From: '+14155559876', To: '+14155551234' },
        {
          headers: { 'x-twilio-signature': 'bad-signature' },
          url: 'https://vocal.devdeepak.me/api/v1/telephony/twilio/voice/number-1',
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED' });

    expect(signatureAdapter.validateWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: 'auth-token',
        url: 'https://vocal.devdeepak.me/api/v1/telephony/twilio/voice/number-1',
      }),
    );
    expect(prisma.call.create).not.toHaveBeenCalled();
  });

  it('bridges an inbound Twilio call to LiveKit only after billing admits it', async () => {
    const { service, prisma, admission, twilioFallback } = makeInboundVoiceService();

    const twiml = await service.handleTwilioVoice(
      'number-1',
      INBOUND_VOICE_PAYLOAD,
      INBOUND_VOICE_REQUEST,
    );

    expect(admission.admitCall).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        callId: 'call-1',
        direction: 'inbound',
        providerCallId: 'CA123',
      }),
    );
    expect(prisma.call.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_providerCallId: { provider: 'twilio', providerCallId: 'CA123' },
        },
        update: {},
      }),
    );
    expect(twilioFallback.buildLiveKitDialTwiml).toHaveBeenCalled();
    expect(twiml).toContain('<Dial>');
  });

  it('refuses an inbound Twilio call and never dials LiveKit when billing denies it', async () => {
    const { service, prisma, twilioFallback } = makeInboundVoiceService({ admitted: false });

    const twiml = await service.handleTwilioVoice(
      'number-1',
      INBOUND_VOICE_PAYLOAD,
      INBOUND_VOICE_REQUEST,
    );

    expect(twilioFallback.buildLiveKitDialTwiml).not.toHaveBeenCalled();
    expect(twiml).toContain('<Hangup/>');
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ status: 'failed', outcome: 'billing_denied' }),
      }),
    );
  });

  it('retries admission after a compensated inbound attempt was finalized', async () => {
    const { service, admission } = makeInboundVoiceService({
      existingCall: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        phoneNumberId: 'number-1',
      },
      existingUsage: { finalizationState: 'finalized' },
    });

    await service.handleTwilioVoice('number-1', INBOUND_VOICE_PAYLOAD, INBOUND_VOICE_REQUEST);

    expect(admission.admitCall).toHaveBeenCalledOnce();
  });

  it('refuses an inbound call whose provider identity belongs to another tenant', async () => {
    const { service, admission, twilioFallback } = makeInboundVoiceService({
      existingCall: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        // A different organization already owns this provider call id. Admitting
        // it here would reserve credit against the wrong payer.
        organizationId: 'org-2',
        agentId: 'agent-1',
        phoneNumberId: 'number-1',
      },
    });

    await expect(
      service.handleTwilioVoice('number-1', INBOUND_VOICE_PAYLOAD, INBOUND_VOICE_REQUEST),
    ).rejects.toMatchObject({ errorCode: 'CALL_IDENTITY_COLLISION' });

    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(twilioFallback.buildLiveKitDialTwiml).not.toHaveBeenCalled();
  });

  it('does not admit an inbound call twice when the provider retries the voice webhook', async () => {
    const { service, admission, twilioFallback } = makeInboundVoiceService({
      existingCall: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        phoneNumberId: 'number-1',
      },
      existingUsage: { finalizationState: 'pending' },
    });

    const twiml = await service.handleTwilioVoice(
      'number-1',
      INBOUND_VOICE_PAYLOAD,
      INBOUND_VOICE_REQUEST,
    );

    expect(admission.admitCall).not.toHaveBeenCalled();
    // The retry still reaches the agent: the call was admitted on first delivery.
    expect(twilioFallback.buildLiveKitDialTwiml).toHaveBeenCalled();
    expect(twiml).toContain('<Dial>');
  });

  it('rejects Vobiz status webhooks without a valid per-number signature before updating calls', async () => {
    const prisma = {
      telephonyPhoneNumber: {
        findUnique: vi.fn(async () => ({
          id: 'number-1',
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          provider: 'vobiz',
          providerMetadata: {
            webhookSecretEncrypted: { encrypted: true },
          },
          providerConnection: null,
        })),
      },
      telephonyWebhookEvent: {
        create: vi.fn(async () => ({ id: 'event-1' })),
      },
      call: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    };
    const signatureAdapter = {
      validateWebhookSignature: vi.fn(async () => false),
    };
    const audit = { log: vi.fn(async () => undefined) };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn(() => signatureAdapter) } as never,
      {
        encryptJson: vi.fn(),
        decryptJson: vi.fn(() => ({ secret: 'vobiz-webhook-secret' })),
      } as never,
      audit as never,
      {} as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.handleStatusWebhook(
        'vobiz',
        'number-1',
        { call_id: 'call-1', status: 'completed' },
        {
          headers: {},
          rawBody: '{"call_id":"call-1","status":"completed"}',
          url: 'https://vocal.devdeepak.me/api/v1/telephony/vobiz/status/number-1',
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED' });

    expect(signatureAdapter.validateWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: 'vobiz-webhook-secret',
        rawBody: '{"call_id":"call-1","status":"completed"}',
        url: 'https://vocal.devdeepak.me/api/v1/telephony/vobiz/status/number-1',
      }),
    );
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'telephony.webhook.invalid_signature',
        metadata: expect.objectContaining({ provider: 'vobiz' }),
      }),
    );
  });

  it('links LiveKit webhooks to calls and updates SIP call status', async () => {
    const startedAt = new Date('2026-06-07T10:00:00.000Z');
    const prisma = {
      telephonyPhoneNumber: {
        findUnique: vi.fn(async () => ({ id: 'number-1', workspaceId: 'workspace-1' })),
      },
      telephonyWebhookEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'webhook-1',
          ...data,
        })),
      },
      call: {
        findFirst: vi.fn(async () => ({
          id: 'call-1',
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          startedAt,
          endedAt: null,
        })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'call-1',
          ...data,
        })),
      },
      callEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'event-1',
          ...data,
        })),
      },
    };
    const livekit = {
      verifyWebhook: vi.fn(() => ({
        id: 'lk-event-1',
        event: 'participant_joined',
        room: { name: 'call-number-1-outbound-123' },
        participant: {
          sid: 'PA_123',
          metadata: '{"phoneNumberId":"number-1","direction":"outbound"}',
          attributes: { 'sip.callStatus': 'ringing' },
        },
      })),
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.handleLiveKitWebhook('{"id":"lk-event-1"}', 'Bearer token'),
    ).resolves.toEqual({
      processed: true,
      event: 'participant_joined',
    });

    expect(prisma.telephonyWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'livekit',
          eventId: 'lk-event-1',
          eventType: 'participant_joined',
          phoneNumberId: 'number-1',
          callId: 'call-1',
          workspaceId: 'workspace-1',
        }),
      }),
    );
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ status: 'ringing', livekitParticipantId: 'PA_123' }),
      }),
    );
    expect(prisma.callEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          callId: 'call-1',
          eventType: 'livekit.participant_joined',
        }),
      }),
    );
  });

  it('keeps trunk-only Vobiz imports pending verification with the user-entered E.164 number', async () => {
    const createdAt = new Date('2026-05-29T00:00:00.000Z');
    const prisma = {
      workspace: {
        findUniqueOrThrow: vi.fn(async () => ({ id: 'workspace-1', organizationId: 'org-1' })),
      },
      telephonyProviderConnection: {
        findFirst: vi.fn(async () => ({
          id: 'connection-1',
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          provider: 'vobiz',
          status: 'connected',
        })),
      },
      telephonyPhoneNumber: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'number-1',
          assignedAgentId: null,
          createdAt,
          ...data,
        })),
      },
    };
    const audit = { log: vi.fn(async () => undefined) };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn() } as never,
      {
        encryptJson: vi.fn((value: unknown) => ({
          encrypted: (value as { secret?: string }).secret,
        })),
        decryptJson: vi.fn(),
      } as never,
      audit as never,
      {} as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    const result = await service.importNumbers('workspace-1', 'user-1', {
      connection_id: 'connection-1',
      numbers: [
        {
          provider_number_id: 'trunk-console-1',
          phone_number: '+912271264217',
          friendly_name: 'Console trunk',
          capabilities: { voice: true, inbound: true, outbound: false },
          webhook_secret: 'vobiz-webhook-secret',
          metadata: {
            sipTrunkId: 'trunk-console-1',
            sipTrunkDomain: 'my-tenant',
            requiresPhoneNumber: true,
            phoneNumberSource: 'manual_import',
          },
        },
      ],
    });

    expect(prisma.telephonyPhoneNumber.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'vobiz',
          providerNumberId: 'trunk-console-1',
          phoneNumberE164: '+912271264217',
          status: 'pending_verification',
          sipTrunkId: 'trunk-console-1',
          providerMetadata: expect.objectContaining({
            sipTrunkDomain: 'my-tenant.sip.vobiz.ai',
            hasWebhookSecret: true,
            webhookSecretEncrypted: { encrypted: 'vobiz-webhook-secret' },
          }),
        }),
      }),
    );
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        phone_number: '+912271264217',
        status: 'pending_verification',
      }),
    );
  });

  it('rejects trunk-only Vobiz imports without the user-specific SIP domain', async () => {
    const prisma = {
      workspace: {
        findUniqueOrThrow: vi.fn(async () => ({ id: 'workspace-1', organizationId: 'org-1' })),
      },
      telephonyProviderConnection: {
        findFirst: vi.fn(async () => ({
          id: 'connection-1',
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          provider: 'vobiz',
          status: 'connected',
        })),
      },
      telephonyPhoneNumber: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.importNumbers('workspace-1', 'user-1', {
        connection_id: 'connection-1',
        numbers: [
          {
            provider_number_id: 'trunk-console-1',
            phone_number: '+912271264217',
            metadata: {
              sipTrunkId: 'trunk-console-1',
              requiresPhoneNumber: true,
              phoneNumberSource: 'manual_import',
            },
          },
        ],
      }),
    ).rejects.toThrow(/Vobiz outbound SIP domain/);

    expect(prisma.telephonyPhoneNumber.create).not.toHaveBeenCalled();
  });

  it('rejects Vobiz imports without a per-number webhook secret', async () => {
    const prisma = {
      workspace: {
        findUniqueOrThrow: vi.fn(async () => ({ id: 'workspace-1', organizationId: 'org-1' })),
      },
      telephonyProviderConnection: {
        findFirst: vi.fn(async () => ({
          id: 'connection-1',
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          provider: 'vobiz',
          status: 'connected',
        })),
      },
      telephonyPhoneNumber: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.importNumbers('workspace-1', 'user-1', {
        connection_id: 'connection-1',
        numbers: [
          {
            provider_number_id: 'trunk-console-1',
            phone_number: '+912271264217',
            metadata: {
              sipTrunkId: 'trunk-console-1',
              requiresPhoneNumber: true,
              phoneNumberSource: 'manual_import',
              sipTrunkDomain: 'tenant.sip.vobiz.ai',
            },
          },
        ],
      }),
    ).rejects.toThrow(/webhook secret/);

    expect(prisma.telephonyPhoneNumber.create).not.toHaveBeenCalled();
  });
});
