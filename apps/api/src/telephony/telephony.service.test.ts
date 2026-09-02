import { Prisma } from '@prisma/client';
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
    reassertLease: vi.fn(async () => true),
    compensate: vi.fn(async () => undefined),
    releaseLease: vi.fn(async () => undefined),
    finalizeUsage: vi.fn(async () => undefined),
    toError: vi.fn(() => new Error('denied')),
  };
}

/**
 * A billing double whose `byo_telephony` gate is satisfied. Every entry point
 * that touches provider connections or numbers consults it, so a `{}` stand-in
 * only worked while the gate fail-opened on a missing dependency.
 */
/**
 * A LiveKit `participant_left` webhook for a call in `status`, plus the prisma
 * doubles it touches. `sip.callStatus` is deliberately absent: LiveKit stops
 * updating the attribute once the participant is gone, which is exactly the
 * shape that used to be filed as a plain `completed`.
 */
function makeLiveKitTerminalPrisma(status: string, outcome: string | null = null) {
  return {
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
        status,
        outcome,
        startedAt: new Date('2026-09-02T10:00:00.000Z'),
        endedAt: null,
      })),
      update: vi.fn(
        async ({ data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
          id: 'call-1',
          ...data,
        }),
      ),
    },
    callEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'event-1',
        ...data,
      })),
    },
  };
}

function makeLiveKitTerminalService(
  prisma: ReturnType<typeof makeLiveKitTerminalPrisma>,
  disconnectReason: string,
) {
  const livekit = {
    verifyWebhook: vi.fn(async () => ({
      id: 'lk-event-2',
      event: 'participant_left',
      room: { name: 'call-number-1-outbound-123' },
      participant: {
        sid: 'PA_123',
        metadata: '{"phoneNumberId":"number-1","direction":"outbound"}',
        disconnectReason,
      },
    })),
  };
  return new TelephonyService(
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
}

function allowByoTelephony() {
  return { checkFeatureGate: vi.fn(async () => true) };
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

/**
 * A workspace whose outbound path is fully permitted, so a duplicate-window test
 * only has to vary what the last 60 seconds of calls look like.
 */
function makeOutboundDuplicateService(recentCalls: Record<string, unknown>[]) {
  const prisma = makePrisma();
  prisma.call.findMany.mockResolvedValue(recentCalls);
  const livekit = {
    createOutboundCall: vi.fn(async () => ({
      providerCallId: 'participant-1',
      roomName: 'room-1',
      status: 'queued',
    })),
    livekitSipHost: 'tenant.sip.livekit.cloud',
  };
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
    makeAdmission() as never,
  );

  return { service, prisma, livekit };
}

const VOBIZ_INBOUND_PAYLOAD = {
  call_id: 'vobiz-call-1',
  event_id: 'evt-1',
  from: '+14155559876',
  to: '+14155551234',
};
const VOBIZ_INBOUND_REQUEST = {
  headers: { 'x-vobiz-signature': 'good-signature' },
  rawBody: '{"call_id":"vobiz-call-1"}',
  url: 'https://vocal.devdeepak.me/api/v1/telephony/vobiz/inbound/number-1',
};

/**
 * A Vobiz number with a stored webhook secret and an assigned agent, so each
 * test only has to vary the signature verdict and the billing decision.
 */
function makeVobizWebhookService(overrides?: { admitted?: boolean; signatureValid?: boolean }) {
  const prisma = {
    telephonyPhoneNumber: {
      findUnique: vi.fn(async () => ({
        id: 'number-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        provider: 'vobiz',
        phoneNumberE164: '+14155551234',
        assignedAgentId: 'agent-1',
        providerMetadata: { webhookSecretEncrypted: { encrypted: true } },
        providerConnection: null,
      })),
    },
    telephonyWebhookEvent: {
      create: vi.fn(async () => ({ id: 'event-1' })),
    },
    call: {
      upsert: vi.fn(async () => ({
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        phoneNumberId: 'number-1',
      })),
      findFirst: vi.fn(),
      update: vi.fn(async () => ({ id: 'call-1' })),
    },
    callUsage: {
      findUnique: vi.fn(async () => null),
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
  const audit = { log: vi.fn(async () => undefined) };
  const service = new TelephonyService(
    prisma as never,
    {} as never,
    {
      adapterFor: vi.fn(() => ({
        validateWebhookSignature: vi.fn(async () => overrides?.signatureValid ?? true),
      })),
    } as never,
    {
      encryptJson: vi.fn(),
      decryptJson: vi.fn(() => ({ secret: 'vobiz-webhook-secret' })),
    } as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    admission as never,
  );

  return { service, prisma, admission, audit };
}

/**
 * A registry whose adapter reports exactly what the connection's credentials can
 * see. `importNumbers` matches every requested number against this listing, so a
 * test that imports has to state what the provider account actually carries.
 */
function registryWithInventory(
  numbers: Array<{ providerNumberId: string; phoneNumberE164: string | null }>,
) {
  return {
    adapterFor: vi.fn(() => ({
      listPhoneNumbers: vi.fn(async () => numbers),
    })),
  };
}

/** A Vobiz account exposing no DIDs, so its listing falls back to a trunk. */
const TRUNK_ONLY_INVENTORY = [{ providerNumberId: 'trunk-console-1', phoneNumberE164: null }];

function makeImportPrisma(provider: 'twilio' | 'vobiz', createdAt = new Date('2026-05-29T00:00:00.000Z')) {
  return {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'workspace-1', organizationId: 'org-1' })),
    },
    telephonyProviderConnection: {
      findFirst: vi.fn(async () => ({
        id: 'connection-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        provider,
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
      delete: vi.fn(async () => ({})),
    },
    call: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'call-1',
        ...data,
      })),
      findFirst: vi.fn(),
      findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
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
        status: 'published',
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
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
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

  it('places a new call when the only recent call to the same number failed terminally', async () => {
    const { service, prisma, livekit } = makeOutboundDuplicateService([
      { id: 'dead-call', status: 'failed', providerCallId: null, livekitRoomName: null },
    ]);

    const result = await service.startOutboundCall('workspace-1', 'user-1', {
      phone_number_id: 'number-1',
      to_number: '+14155559876',
    });

    // Replaying a failed call would tell the caller a call was placed when none
    // was, and would silently swallow the retry.
    expect(prisma.call.create).toHaveBeenCalled();
    expect(livekit.createOutboundCall).toHaveBeenCalled();
    expect(result.call_id).toBe('call-1');
  });

  it('reuses a recent in-flight call to the same number instead of placing a second one', async () => {
    const { service, prisma, livekit } = makeOutboundDuplicateService([
      { id: 'live-call', status: 'ringing', providerCallId: 'p-1', livekitRoomName: 'room-old' },
    ]);

    const result = await service.startOutboundCall('workspace-1', 'user-1', {
      phone_number_id: 'number-1',
      to_number: '+14155559876',
    });

    expect(prisma.call.create).not.toHaveBeenCalled();
    expect(livekit.createOutboundCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ call_id: 'live-call', room_name: 'room-old' });
  });

  it('reuses a recent completed call to the same number rather than dialling it again', async () => {
    const { service, livekit } = makeOutboundDuplicateService([
      { id: 'done-call', status: 'completed', providerCallId: 'p-1', livekitRoomName: 'room-old' },
    ]);

    const result = await service.startOutboundCall('workspace-1', 'user-1', {
      phone_number_id: 'number-1',
      to_number: '+14155559876',
    });

    expect(livekit.createOutboundCall).not.toHaveBeenCalled();
    expect(result.call_id).toBe('done-call');
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
    // The retry does not reserve a second minute, but it must still hold a
    // concurrency slot before it is bridged.
    expect(admission.reassertLease).toHaveBeenCalledWith('org-1', 'call-1');
    // The retry still reaches the agent: the call was admitted on first delivery.
    expect(twilioFallback.buildLiveKitDialTwiml).toHaveBeenCalled();
    expect(twiml).toContain('<Dial>');
  });

  it('refuses a retried voice webhook whose concurrency lease cannot be re-asserted', async () => {
    const { service, admission, prisma, twilioFallback } = makeInboundVoiceService({
      existingCall: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        phoneNumberId: 'number-1',
      },
      existingUsage: { finalizationState: 'pending' },
    });
    admission.reassertLease.mockResolvedValue(false);

    const twiml = await service.handleTwilioVoice(
      'number-1',
      INBOUND_VOICE_PAYLOAD,
      INBOUND_VOICE_REQUEST,
    );

    // The original lease expired and the organization is at capacity again:
    // bridging now would exceed the concurrency cap, so the retry is refused.
    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(twilioFallback.buildLiveKitDialTwiml).not.toHaveBeenCalled();
    expect(twiml).toContain('<Hangup/>');
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ status: 'failed', outcome: 'billing_denied' }),
      }),
    );
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

  it('creates and evaluates admission for an inbound Vobiz call instead of only recording a status event', async () => {
    const { service, prisma, admission } = makeVobizWebhookService();

    const result = await service.handleVobizInboundWebhook(
      'number-1',
      VOBIZ_INBOUND_PAYLOAD,
      VOBIZ_INBOUND_REQUEST,
    );

    expect(prisma.call.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_providerCallId: { provider: 'vobiz', providerCallId: 'vobiz-call-1' } },
        create: expect.objectContaining({
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          agentId: 'agent-1',
          phoneNumberId: 'number-1',
          direction: 'inbound',
          provider: 'vobiz',
          providerCallId: 'vobiz-call-1',
          fromNumber: '+14155559876',
          toNumber: '+14155551234',
        }),
      }),
    );
    expect(admission.admitCall).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        callId: 'call-1',
        direction: 'inbound',
      }),
    );
    expect(prisma.telephonyWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'call.inbound', signatureValid: true }),
      }),
    );
    expect(result).toMatchObject({ processed: true, call_id: 'call-1', admitted: true });
  });

  it('lets a billing-denied inbound Vobiz call proceed and records that admission was not enforced', async () => {
    const { service, prisma, audit } = makeVobizWebhookService({ admitted: false });

    const result = await service.handleVobizInboundWebhook(
      'number-1',
      VOBIZ_INBOUND_PAYLOAD,
      VOBIZ_INBOUND_REQUEST,
    );

    // Vobiz media goes straight to LiveKit, so this webhook cannot refuse the
    // call: the denial is recorded, and the call is not killed.
    expect(result).toMatchObject({ admitted: false });
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'telephony.inbound_call.admission_not_enforced',
        resourceId: 'call-1',
        metadata: expect.objectContaining({ provider: 'vobiz', enforcement: 'advisory' }),
      }),
    );
  });

  it('rejects an inbound Vobiz webhook with an invalid signature before creating a call', async () => {
    const { service, prisma, admission } = makeVobizWebhookService({ signatureValid: false });

    await expect(
      service.handleVobizInboundWebhook(
        'number-1',
        VOBIZ_INBOUND_PAYLOAD,
        VOBIZ_INBOUND_REQUEST,
      ),
    ).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED' });

    expect(prisma.call.upsert).not.toHaveBeenCalled();
    expect(admission.admitCall).not.toHaveBeenCalled();
  });

  it('records a Vobiz verification webhook under its own event type without admitting a call', async () => {
    const { service, prisma, admission } = makeVobizWebhookService();

    const result = await service.handleVobizVerifyWebhook(
      'number-1',
      { event_id: 'evt-verify-1' },
      { ...VOBIZ_INBOUND_REQUEST, rawBody: '{"event_id":"evt-verify-1"}' },
    );

    expect(prisma.telephonyWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'number.verify', signatureValid: true }),
      }),
    );
    expect(prisma.call.upsert).not.toHaveBeenCalled();
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: true });
  });

  it('rejects a Vobiz verification webhook with an invalid signature', async () => {
    const { service, prisma } = makeVobizWebhookService({ signatureValid: false });

    await expect(
      service.handleVobizVerifyWebhook('number-1', { event_id: 'evt-verify-1' }, VOBIZ_INBOUND_REQUEST),
    ).rejects.toMatchObject({ errorCode: 'UNAUTHORIZED' });

    expect(prisma.telephonyWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signatureValid: false }) }),
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
        where: expect.objectContaining({ id: 'call-1' }),
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

  // 2026-09-02: a campaign dial to a mobile that never picked up was stored as
  // `completed` with a null outcome, so the call list showed an unanswered dial
  // as a finished conversation and campaign stats counted it as a success.
  it.each([
    ['USER_UNAVAILABLE', 'no_answer'],
    ['USER_REJECTED', 'declined'],
    // A trunk failure is the carrier failing the dial, not a callee ignoring it.
    ['SIP_TRUNK_FAILURE', 'provider_dispatch_failed'],
  ])('records a call that ended while still %s as failed / %s', async (reason, outcome) => {
    const prisma = makeLiveKitTerminalPrisma('ringing');
    const service = makeLiveKitTerminalService(prisma, reason);

    await service.handleLiveKitWebhook('{"id":"lk-event-2"}', 'Bearer token');

    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'call-1' }),
        data: expect.objectContaining({ status: 'failed', outcome }),
      }),
    );
  });

  /**
   * LiveKit sends participant_left and room_finished for the same hang-up, and
   * redelivers on a failed ack. The second one used to overwrite the failure with
   * `completed`, leaving a call that is failed by outcome and successful by
   * status - which campaign statistics then counted as a success.
   */
  it('leaves an already failed call failed when a second terminal event arrives', async () => {
    const prisma = makeLiveKitTerminalPrisma('failed', 'no_answer');
    const service = makeLiveKitTerminalService(prisma, 'USER_UNAVAILABLE');

    await service.handleLiveKitWebhook('{"id":"lk-event-3"}', 'Bearer token');

    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.callEvent.create).toHaveBeenCalledTimes(1);
  });

  /**
   * The two events for one hang-up are handled concurrently, so both read the
   * call as `ringing` and the read-side guard above sees nothing. The status
   * guard in the update's WHERE makes the loser's write a P2025 instead of a
   * second write over the outcome the winner recorded.
   */
  it('lets a concurrent duplicate terminal event lose the race without a second write', async () => {
    const prisma = makeLiveKitTerminalPrisma('ringing');
    prisma.call.update.mockResolvedValueOnce({ id: 'call-1' }).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    const service = makeLiveKitTerminalService(prisma, 'USER_UNAVAILABLE');

    await Promise.all([
      service.handleLiveKitWebhook('{"id":"lk-event-2"}', 'Bearer token'),
      service.handleLiveKitWebhook('{"id":"lk-event-3"}', 'Bearer token'),
    ]);

    expect(prisma.call.update).toHaveBeenCalledTimes(2);
    for (const [args] of prisma.call.update.mock.calls) {
      expect(args.where).toEqual({
        id: 'call-1',
        status: { notIn: ['failed', 'cancelled'] },
      });
    }
    // Both deliveries are still recorded against the call.
    expect(prisma.callEvent.create).toHaveBeenCalledTimes(2);
  });

  it('still records a call that had connected as completed', async () => {
    const prisma = makeLiveKitTerminalPrisma('in_progress');
    const service = makeLiveKitTerminalService(prisma, 'CLIENT_INITIATED');

    await service.handleLiveKitWebhook('{"id":"lk-event-2"}', 'Bearer token');

    const data = prisma.call.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe('completed');
    expect(data.outcome).toBeUndefined();
  });

  it('awaits the asynchronous LiveKit webhook verification before reading the event', async () => {
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
      // WebhookReceiver.receive() returns a Promise in livekit-server-sdk v2. Parsing
      // the Promise itself recorded every event as `livekit.unknown` with a `{}`
      // payload and never linked it to a call (production incident 2026-09-01).
      verifyWebhook: vi.fn(async () => ({
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
        where: expect.objectContaining({ id: 'call-1' }),
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
    const prisma = makeImportPrisma('vobiz');
    const audit = { log: vi.fn(async () => undefined) };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      registryWithInventory(TRUNK_ONLY_INVENTORY) as never,
      {
        encryptJson: vi.fn((value: unknown) => ({
          encrypted: (value as { secret?: string }).secret,
        })),
        decryptJson: vi.fn(),
      } as never,
      audit as never,
      allowByoTelephony() as never,
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

  it('refuses to import provider numbers when the plan excludes BYO telephony', async () => {
    const prisma = {
      workspace: {
        findUniqueOrThrow: vi.fn(async () => ({ id: 'workspace-1', organizationId: 'org-1' })),
      },
      telephonyProviderConnection: { findFirst: vi.fn() },
      telephonyPhoneNumber: { findUnique: vi.fn(), create: vi.fn() },
    };
    const billing = {
      checkFeatureGate: vi.fn(
        async (_organizationId: string, gate: string) => gate !== 'byo_telephony',
      ),
    };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      billing as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.importNumbers('workspace-1', 'user-1', {
        connection_id: 'connection-1',
        numbers: [{ provider_number_id: 'trunk-1', phone_number: '+912271264217' }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenPlanError);

    expect(billing.checkFeatureGate).toHaveBeenCalledWith('org-1', 'byo_telephony');
    // Refused before the connection is even resolved, so nothing is imported.
    expect(prisma.telephonyProviderConnection.findFirst).not.toHaveBeenCalled();
    expect(prisma.telephonyPhoneNumber.create).not.toHaveBeenCalled();
  });

  it('rejects trunk-only Vobiz imports without the user-specific SIP domain', async () => {
    const prisma = makeImportPrisma('vobiz');
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      registryWithInventory(TRUNK_ONLY_INVENTORY) as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      allowByoTelephony() as never,
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
    const prisma = makeImportPrisma('vobiz');
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      registryWithInventory(TRUNK_ONLY_INVENTORY) as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      allowByoTelephony() as never,
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

  /**
   * `importNumbers` used to take `dto.numbers` on faith while holding the very
   * credentials that prove ownership. `phoneNumberE164` is uniquely indexed, so
   * an unchecked import lets one workspace claim any number string and deny its
   * rightful owner a connection forever.
   */
  it('refuses to import a number that is not in the connection account', async () => {
    const prisma = makeImportPrisma('twilio');
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      registryWithInventory([
        { providerNumberId: 'PN1', phoneNumberE164: '+14155550000' },
      ]) as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.importNumbers('workspace-1', 'user-1', {
        connection_id: 'connection-1',
        numbers: [{ provider_number_id: 'PN2', phone_number: '+14155559999' }],
      }),
    ).rejects.toThrow(/\+14155559999 is not in this provider connection's account/);

    // Refused before the duplicate lookup, so the caller learns nothing about
    // which numbers other workspaces hold.
    expect(prisma.telephonyPhoneNumber.findUnique).not.toHaveBeenCalled();
    expect(prisma.telephonyPhoneNumber.create).not.toHaveBeenCalled();
  });

  it('imports a number the provider account carries and marks it verified', async () => {
    const prisma = makeImportPrisma('twilio');
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      registryWithInventory([
        { providerNumberId: 'PN1', phoneNumberE164: '+14155551234' },
      ]) as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    const result = await service.importNumbers('workspace-1', 'user-1', {
      connection_id: 'connection-1',
      // The status must come from the provider listing, not from this metadata:
      // it is client-supplied, so a squatter could otherwise label its own claim.
      numbers: [
        {
          provider_number_id: 'PN1',
          phone_number: '+14155551234',
          metadata: { requiresPhoneNumber: true },
        },
      ],
    });

    expect(prisma.telephonyPhoneNumber.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phoneNumberE164: '+14155551234', status: 'verified' }),
      }),
    );
    expect(result.items[0]).toEqual(expect.objectContaining({ status: 'verified' }));
  });

  /**
   * The provider id is server-derived from the inventory record the E.164
   * matched, never the caller's claim: routing configures the provider resource
   * that id names, so a caller-supplied id could bind a verified number to a
   * DIFFERENT resource in the account.
   */
  it("persists the inventory record's provider id, not the caller's", async () => {
    const prisma = makeImportPrisma('twilio');
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      registryWithInventory([
        { providerNumberId: 'PN_REAL', phoneNumberE164: '+14155551234' },
        { providerNumberId: 'PN_OTHER', phoneNumberE164: '+14155559999' },
      ]) as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await service.importNumbers('workspace-1', 'user-1', {
      connection_id: 'connection-1',
      numbers: [
        {
          // The caller claims a different resource in the same account.
          provider_number_id: 'PN_OTHER',
          phone_number: '+14155551234',
        },
      ],
    });

    expect(prisma.telephonyPhoneNumber.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneNumberE164: '+14155551234',
          providerNumberId: 'PN_REAL',
        }),
      }),
    );
  });

  /**
   * `pending_verification` was written by `createManualNumber` and read by
   * nothing: assign → configure-livekit walked an unproven claim straight to
   * `livekit_configured`. Inbound stays open on purpose — a carrier only delivers
   * for numbers actually in its account.
   */
  it('refuses to assign an agent to a number that is still pending verification', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider: 'vobiz',
      phoneNumberE164: '+912271264217',
      status: 'pending_verification',
      inboundEnabled: true,
      outboundEnabled: false,
    } as never);
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.assignAgent('workspace-1', 'number-1', 'user-1', { agent_id: 'agent-1' }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_STATUS' });

    expect(prisma.telephonyPhoneNumber.update).not.toHaveBeenCalled();
  });

  it('refuses an outbound call from a number that is still pending verification', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider: 'vobiz',
      phoneNumberE164: '+912271264217',
      status: 'pending_verification',
      assignedAgentId: 'agent-1',
      outboundEnabled: true,
      livekitConfig: { outboundTrunkId: 'trunk-out-1' },
    } as never);
    const livekit = { createOutboundCall: vi.fn(), livekitSipHost: 'tenant.sip.livekit.cloud' };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn() } as never,
      allowByoTelephony() as never,
      { check: vi.fn(), attachCheckToCall: vi.fn() } as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.startOutboundCall('workspace-1', 'user-1', {
        phone_number_id: 'number-1',
        to_number: '+14155559876',
      }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_STATUS' });

    expect(prisma.call.create).not.toHaveBeenCalled();
    expect(livekit.createOutboundCall).not.toHaveBeenCalled();
  });

  /**
   * Workspace with 2 managed and 3 BYO numbers, so the quota assertion has a
   * combined count to be checked against.
   */
  function makeSipCreateService(overrides?: { assertAllowed?: ReturnType<typeof vi.fn> }) {
    const prisma = {
      workspace: {
        findUniqueOrThrow: vi.fn(async () => ({ id: 'workspace-1', organizationId: 'org-1' })),
      },
      twilioPhoneNumber: { count: vi.fn(async () => 2) },
      telephonyPhoneNumber: {
        count: vi.fn(async () => 3),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'number-1',
          assignedAgentId: null,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          ...data,
        })),
      },
    };
    const encryption = {
      encryptJson: vi.fn((value: unknown) => ({ encrypted: value })),
      decryptJson: vi.fn(),
    };
    const audit = { log: vi.fn(async () => undefined) };
    const entitlements = {
      assertAllowed: overrides?.assertAllowed ?? vi.fn(async () => ({ allowed: true })),
    };
    const service = new TelephonyService(
      prisma as never,
      {} as never,
      { adapterFor: vi.fn() } as never,
      encryption as never,
      audit as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
      undefined,
      entitlements as never,
    );
    return { service, prisma, encryption, audit, entitlements };
  }

  it('creates a verified SIP trunk number with encrypted auth and a combined quota count', async () => {
    const { service, prisma, encryption, audit, entitlements } = makeSipCreateService();

    const result = await service.createSipTrunkNumber('workspace-1', 'user-1', {
      phone_number: '+14155551234',
      sip_trunk_domain: 'sip.example.com',
      sip_auth_username: 'alice',
      sip_auth_password: 'secret-pass',
    });

    expect(entitlements.assertAllowed).toHaveBeenCalledWith('org-1', {
      kind: 'phone_number_create',
      current: 5,
    });
    expect(encryption.encryptJson).toHaveBeenCalledTimes(2);
    expect(prisma.telephonyPhoneNumber.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          provider: 'sip',
          phoneNumberE164: '+14155551234',
          friendlyName: '+14155551234',
          status: 'verified',
          inboundEnabled: true,
          outboundEnabled: true,
          providerMetadata: expect.objectContaining({
            sipTrunkDomain: 'sip.example.com',
            sipAuthUsernameEncrypted: { encrypted: { value: 'alice' } },
            sipAuthPasswordEncrypted: { encrypted: { value: 'secret-pass' } },
          }),
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'telephony.phone_number.sip_create',
        resourceId: 'number-1',
      }),
    );
    expect(result).toMatchObject({
      status: 'verified',
      phone_number: '+14155551234',
      friendly_name: '+14155551234',
      inbound_enabled: true,
      outbound_enabled: true,
    });
  });

  it('rejects a SIP auth password supplied without a username', async () => {
    const { service, prisma, encryption } = makeSipCreateService();

    await expect(
      service.createSipTrunkNumber('workspace-1', 'user-1', {
        phone_number: '+14155551234',
        sip_trunk_domain: 'sip.example.com',
        sip_auth_password: 'secret-pass',
      }),
    ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });

    expect(encryption.encryptJson).not.toHaveBeenCalled();
    expect(prisma.telephonyPhoneNumber.create).not.toHaveBeenCalled();
  });

  it('propagates an over-quota rejection before creating the SIP number', async () => {
    const assertAllowed = vi.fn(async () => {
      throw new Error('phone number quota exceeded');
    });
    const { service, prisma } = makeSipCreateService({ assertAllowed });

    await expect(
      service.createSipTrunkNumber('workspace-1', 'user-1', {
        phone_number: '+14155551234',
        sip_trunk_domain: 'sip.example.com',
      }),
    ).rejects.toThrow(/quota exceeded/);

    expect(prisma.telephonyPhoneNumber.create).not.toHaveBeenCalled();
  });

  it('passes decrypted SIP auth to both trunk calls and persists the encrypted blobs', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider: 'sip',
      phoneNumberE164: '+14155551234',
      status: 'verified',
      assignedAgentId: 'agent-1',
      inboundEnabled: true,
      outboundEnabled: true,
      providerConnection: null,
      livekitConfig: null,
      providerMetadata: {
        sipTrunkDomain: 'sip.example.com',
        sipAuthUsernameEncrypted: { encrypted: 'user-blob' },
        sipAuthPasswordEncrypted: { encrypted: 'pass-blob' },
      },
    } as never);
    const livekit = {
      createInboundSipTrunk: vi.fn(async (_params: Record<string, unknown>) => ({
        trunkId: 'trunk-in-1',
      })),
      createOutboundSipTrunk: vi.fn(async (_params: Record<string, unknown>) => ({
        trunkId: 'trunk-out-1',
      })),
      createDispatchRule: vi.fn(async () => ({ dispatchRuleId: 'dispatch-1' })),
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const decryptJson = vi.fn((blob: { encrypted: string }) => ({
      value: blob.encrypted === 'user-blob' ? 'alice' : 'secret-pass',
    }));
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await service.configureLiveKit('workspace-1', 'number-1', 'user-1');

    expect(livekit.createInboundSipTrunk).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'sip',
        authUsername: 'alice',
        authPassword: 'secret-pass',
      }),
    );
    expect(livekit.createOutboundSipTrunk).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'sip',
        sipAddress: 'sip.example.com',
        authUsername: 'alice',
        authPassword: 'secret-pass',
      }),
    );
    expect(prisma.liveKitTelephonyConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sipAuthUsernameEncrypted: { encrypted: 'user-blob' },
          sipAuthPasswordEncrypted: { encrypted: 'pass-blob' },
        }),
        update: expect.objectContaining({
          sipAuthUsernameEncrypted: { encrypted: 'user-blob' },
          sipAuthPasswordEncrypted: { encrypted: 'pass-blob' },
        }),
      }),
    );
  });

  it('does not pass SIP auth to LiveKit when the number carries no stored credentials', async () => {
    const prisma = makePrisma();
    const livekit = {
      createInboundSipTrunk: vi.fn(async (_params: Record<string, unknown>) => ({
        trunkId: 'trunk-in-1',
      })),
      createOutboundSipTrunk: vi.fn(async (_params: Record<string, unknown>) => ({
        trunkId: 'trunk-out-1',
      })),
      createDispatchRule: vi.fn(async () => ({ dispatchRuleId: 'dispatch-1' })),
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const decryptJson = vi.fn();
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await service.configureLiveKit('workspace-1', 'number-1', 'user-1');

    expect(decryptJson).not.toHaveBeenCalled();
    const inboundParams = livekit.createInboundSipTrunk.mock.calls[0][0];
    expect('authUsername' in inboundParams).toBe(false);
    expect('authPassword' in inboundParams).toBe(false);
    const outboundParams = livekit.createOutboundSipTrunk.mock.calls[0][0];
    expect('authUsername' in outboundParams).toBe(false);
    expect('authPassword' in outboundParams).toBe(false);
    expect(prisma.liveKitTelephonyConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sipAuthUsernameEncrypted: Prisma.JsonNull,
          sipAuthPasswordEncrypted: Prisma.JsonNull,
        }),
      }),
    );
  });

  it('fails before creating any trunk when LIVEKIT_SIP_HOST is unconfigured', async () => {
    const prisma = makePrisma();
    const livekit = {
      createInboundSipTrunk: vi.fn(),
      createOutboundSipTrunk: vi.fn(),
      createDispatchRule: vi.fn(),
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
      get livekitSipHost(): string {
        throw new Error('LIVEKIT_SIP_HOST is not configured.');
      },
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.configureLiveKit('workspace-1', 'number-1', 'user-1'),
    ).rejects.toThrow('LIVEKIT_SIP_HOST');

    // A configuration error must not strand a trunk: LiveKit refuses a second
    // inbound trunk covering the same number, which would block every retry.
    expect(livekit.createInboundSipTrunk).not.toHaveBeenCalled();
    expect(livekit.createOutboundSipTrunk).not.toHaveBeenCalled();
  });

  it('deletes the previous LiveKit resources before re-configuring a number', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider: 'sip',
      phoneNumberE164: '+14155551234',
      status: 'livekit_configured',
      assignedAgentId: 'agent-1',
      inboundEnabled: true,
      outboundEnabled: true,
      providerConnection: null,
      livekitConfig: {
        inboundTrunkId: 'old-in',
        outboundTrunkId: 'old-out',
        dispatchRuleId: 'old-dispatch',
      },
      providerMetadata: { sipTrunkDomain: 'sip.example.com' },
    } as never);
    const livekit = {
      createInboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-in-2' })),
      createOutboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-out-2' })),
      createDispatchRule: vi.fn(async () => ({ dispatchRuleId: 'dispatch-2' })),
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await service.configureLiveKit('workspace-1', 'number-1', 'user-1');

    expect(livekit.deleteDispatchRule).toHaveBeenCalledWith('old-dispatch');
    expect(livekit.deleteSipTrunk).toHaveBeenCalledWith('old-in');
    expect(livekit.deleteSipTrunk).toHaveBeenCalledWith('old-out');
    expect(livekit.createInboundSipTrunk).toHaveBeenCalled();
  });

  it('deletes the trunks it created when a later configure step fails', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider: 'sip',
      phoneNumberE164: '+14155551234',
      status: 'verified',
      assignedAgentId: 'agent-1',
      inboundEnabled: true,
      outboundEnabled: true,
      providerConnection: null,
      livekitConfig: null,
      providerMetadata: { sipTrunkDomain: 'sip.example.com' },
    } as never);
    const livekit = {
      createInboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-in-1' })),
      createOutboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-out-1' })),
      createDispatchRule: vi.fn(async () => {
        throw new Error('dispatch exploded');
      }),
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.configureLiveKit('workspace-1', 'number-1', 'user-1'),
    ).rejects.toThrow('dispatch exploded');

    // The partially configured number stays retryable.
    expect(livekit.deleteSipTrunk).toHaveBeenCalledWith('trunk-in-1');
    expect(livekit.deleteSipTrunk).toHaveBeenCalledWith('trunk-out-1');
    expect(prisma.liveKitTelephonyConfig.upsert).not.toHaveBeenCalled();
  });

  it('refuses assigning a draft agent with a publish message', async () => {
    const prisma = makePrisma();
    prisma.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      name: 'Sales Agent',
      status: 'draft',
      activeVersionId: 'version-1',
    } as never);
    const service = new TelephonyService(
      prisma as never,
      { deleteSipTrunk: vi.fn(), deleteDispatchRule: vi.fn() } as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.assignAgent('workspace-1', 'number-1', 'user-1', { agent_id: 'agent-1' } as never),
    ).rejects.toMatchObject({ errorCode: 'AGENT_NOT_PUBLISHED' });
    expect(prisma.telephonyPhoneNumber.update).not.toHaveBeenCalled();
  });

  it('hard-deletes the number and its LiveKit resources on disconnect', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider: 'sip',
      phoneNumberE164: '+14155551234',
      friendlyName: '+14155551234',
      status: 'livekit_configured',
      assignedAgentId: 'agent-1',
      inboundEnabled: true,
      outboundEnabled: true,
      livekitConfig: {
        inboundTrunkId: 'trunk-in-1',
        outboundTrunkId: 'trunk-out-1',
        dispatchRuleId: 'dispatch-1',
      },
      providerMetadata: { sipTrunkDomain: 'sip.example.com' },
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    } as never);
    const livekit = {
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const audit = { log: vi.fn(async () => undefined) };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      audit as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    const dto = await service.disconnectNumber('workspace-1', 'number-1', 'user-1');

    // The row is removed, not status-flipped: the global E.164 unique
    // constraint would otherwise block ever re-adding the number.
    expect(prisma.telephonyPhoneNumber.delete).toHaveBeenCalledWith({
      where: { id: 'number-1' },
    });
    expect(livekit.deleteDispatchRule).toHaveBeenCalledWith('dispatch-1');
    expect(livekit.deleteSipTrunk).toHaveBeenCalledWith('trunk-in-1');
    expect(livekit.deleteSipTrunk).toHaveBeenCalledWith('trunk-out-1');
    expect(dto.status).toBe('disconnected');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'telephony.phone_number.disconnect',
        metadata: { phone_number: '+14155551234', provider: 'sip' },
      }),
    );
  });

  it('404s a disconnect for a number outside the workspace', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue(null as never);
    const service = new TelephonyService(
      prisma as never,
      { deleteSipTrunk: vi.fn(), deleteDispatchRule: vi.fn() } as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await expect(
      service.disconnectNumber('workspace-1', 'number-x', 'user-1'),
    ).rejects.toMatchObject({ errorCode: 'TELEPHONY_NOT_FOUND' });
  });

  /** A verified number with an agent to assign, varying only the provider. */
  function makeAssignService(provider: 'sip' | 'vobiz') {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider,
      phoneNumberE164: '+14155551234',
      status: 'verified',
      assignedAgentId: 'agent-1',
      inboundEnabled: true,
      outboundEnabled: true,
      providerConnection: null,
      livekitConfig: null,
      providerMetadata: { sipTrunkDomain: 'sip.example.com' },
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    } as never);
    prisma.telephonyPhoneNumber.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        ({
          id: 'number-1',
          provider,
          phoneNumberE164: '+14155551234',
          friendlyName: null,
          status: 'verified',
          inboundEnabled: true,
          outboundEnabled: true,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          ...data,
        }) as never,
    );
    const livekit = {
      createInboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-in-1' })),
      createOutboundSipTrunk: vi.fn(async () => ({ trunkId: 'trunk-out-1' })),
      createDispatchRule: vi.fn(async () => ({ dispatchRuleId: 'dispatch-1' })),
      deleteSipTrunk: vi.fn(async () => undefined),
      deleteDispatchRule: vi.fn(async () => undefined),
      livekitSipHost: 'tenant.sip.livekit.cloud',
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      { log: vi.fn(async () => undefined) } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );
    return { service, prisma, livekit };
  }

  it('auto-configures LiveKit when an agent is assigned to a SIP trunk number', async () => {
    const { service, prisma, livekit } = makeAssignService('sip');

    await service.assignAgent('workspace-1', 'number-1', 'user-1', { agent_id: 'agent-1' });

    expect(livekit.createInboundSipTrunk).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'sip', phoneNumberId: 'number-1' }),
    );
    expect(prisma.liveKitTelephonyConfig.upsert).toHaveBeenCalled();
  });

  it('auto-configures LiveKit for a provider-connected number too', async () => {
    // Assignment is the last step for every provider now: the separate
    // "configure" button was a dead end that left numbers verified-but-silent.
    const { service, prisma, livekit } = makeAssignService('vobiz');

    await service.assignAgent('workspace-1', 'number-1', 'user-1', { agent_id: 'agent-1' });

    expect(livekit.createInboundSipTrunk).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'vobiz', phoneNumberId: 'number-1' }),
    );
    expect(prisma.liveKitTelephonyConfig.upsert).toHaveBeenCalled();
  });
});

/**
 * A SIP-delivered inbound leg: LiveKit already has the caller in a room and the
 * agent is asking whether the call is paid for. No provider webhook was
 * involved, so nothing has admitted it yet.
 */
function makeSipInboundService(overrides?: {
  admitted?: boolean;
  number?: Record<string, unknown> | null;
  hungUp?: boolean;
}) {
  const prisma = {
    telephonyPhoneNumber: {
      findUnique: vi.fn(async () =>
        overrides?.number === undefined
          ? {
              id: 'number-1',
              workspaceId: 'workspace-1',
              organizationId: 'org-1',
              assignedAgentId: 'agent-1',
              provider: 'sip',
              phoneNumberE164: '+917969007408',
            }
          : overrides.number,
      ),
    },
    call: {
      upsert: vi.fn(async () => ({
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        phoneNumberId: 'number-1',
      })),
      update: vi.fn(async () => ({ id: 'call-1' })),
    },
    callUsage: {
      findUnique: vi.fn(async () => null),
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
        : { admitted: false as const, reason: 'credit_insufficient' as const, message: 'No credit.' },
    ),
  };
  const livekit = { hangUpParticipant: vi.fn(async () => overrides?.hungUp ?? true) };
  const service = new TelephonyService(
    prisma as never,
    livekit as never,
    {} as never,
    {} as never,
    { log: vi.fn(async () => undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    admission as never,
  );
  return { service, prisma, admission, livekit };
}

const SIP_ADMIT_REQUEST = {
  organizationId: 'org-1',
  workspaceId: 'workspace-1',
  phoneNumberId: 'number-1',
  agentId: 'agent-1',
  provider: 'sip' as const,
  providerCallId: 'lk-call-99',
  fromNumber: '+919000000001',
  toNumber: '+917969007408',
  roomName: 'call-room-1',
  participantIdentity: 'sip_participant_1',
};

describe('TelephonyService.admitSipInboundCall', () => {
  it('admits an inbound call that reached LiveKit without a provider webhook', async () => {
    const { service, prisma, admission } = makeSipInboundService();

    await expect(service.admitSipInboundCall(SIP_ADMIT_REQUEST)).resolves.toEqual({
      admitted: true,
      callId: 'call-1',
      reason: null,
    });

    expect(prisma.call.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_providerCallId: { provider: 'sip', providerCallId: 'lk-call-99' } },
        update: {},
      }),
    );
    expect(admission.admitCall).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        callId: 'call-1',
        direction: 'inbound',
        provider: 'livekit',
        providerCallId: 'lk-call-99',
      }),
    );
  });

  it('hangs up the carrier leg when billing refuses the call', async () => {
    const { service, prisma, livekit } = makeSipInboundService({ admitted: false });

    await expect(service.admitSipInboundCall(SIP_ADMIT_REQUEST)).resolves.toEqual({
      admitted: false,
      callId: 'call-1',
      reason: 'credit_insufficient',
    });

    // Refusal on this path has to be enforced: unlike the TwiML path there is no
    // response body that can hang up, so the SIP participant is removed.
    expect(livekit.hangUpParticipant).toHaveBeenCalledWith('call-room-1', 'sip_participant_1');
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ status: 'failed', outcome: 'billing_denied' }),
      }),
    );
  });

  it('refuses without billing anything when the number is no longer assigned to that agent', async () => {
    const { service, prisma, admission, livekit } = makeSipInboundService({
      number: {
        id: 'number-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        assignedAgentId: 'agent-2',
        provider: 'sip',
        phoneNumberE164: '+917969007408',
      },
    });

    await expect(service.admitSipInboundCall(SIP_ADMIT_REQUEST)).resolves.toEqual({
      admitted: false,
      callId: null,
      reason: 'number_not_assigned',
    });
    expect(prisma.call.upsert).not.toHaveBeenCalled();
    expect(admission.admitCall).not.toHaveBeenCalled();
    // Nothing will ever answer this leg, so it must not be left ringing.
    expect(livekit.hangUpParticipant).toHaveBeenCalledWith('call-room-1', 'sip_participant_1');
  });

  it('rejects a request whose tenant does not own the number', async () => {
    const { service, admission, livekit } = makeSipInboundService({
      number: {
        id: 'number-1',
        workspaceId: 'workspace-2',
        organizationId: 'org-2',
        assignedAgentId: 'agent-1',
        provider: 'sip',
        phoneNumberE164: '+917969007408',
      },
    });

    await expect(service.admitSipInboundCall(SIP_ADMIT_REQUEST)).rejects.toMatchObject({
      errorCode: 'TELEPHONY_NOT_FOUND',
    });
    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(livekit.hangUpParticipant).toHaveBeenCalledWith('call-room-1', 'sip_participant_1');
  });

  it('flags a refusal it could not enforce so the leg is not assumed dead', async () => {
    const { service } = makeSipInboundService({ admitted: false, hungUp: false });

    await expect(service.admitSipInboundCall(SIP_ADMIT_REQUEST)).resolves.toEqual({
      admitted: false,
      callId: 'call-1',
      reason: 'credit_insufficient_still_connected',
    });
  });

});

describe('TelephonyService.disconnectNumber', () => {
  /**
   * A number left attached to the trunk after the config is gone keeps sending
   * calls to a trunk nothing dispatches into, and the customer cannot take the
   * number back into their own Programmable Voice app.
   */
  it('releases the number at the provider before deleting it', async () => {
    const prisma = makePrisma();
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'number-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      provider: 'twilio',
      phoneNumberE164: '+14155551234',
      providerNumberId: 'PN123',
      sipTrunkId: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      status: 'livekit_configured',
      inboundEnabled: true,
      outboundEnabled: true,
      livekitConfig: {
        dispatchRuleId: 'rule-1',
        inboundTrunkId: 'trunk-in-1',
        outboundTrunkId: 'trunk-out-1',
      },
      providerConnection: {
        encryptedCredentials: { cipher: 'x' },
        metadata: { twilioTrunk: { trunkSid: 'TK1', username: 'vf_dead' } },
      },
    } as never);
    const removeRouting = vi.fn(async () => undefined);
    const livekit = {
      deleteDispatchRule: vi.fn(async () => undefined),
      deleteSipTrunk: vi.fn(async () => undefined),
    };
    const service = new TelephonyService(
      prisma as never,
      livekit as never,
      { adapterFor: vi.fn(() => ({ removeRouting })) } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn(() => ({ accountSid: 'AC', authToken: 't' })) } as never,
      { log: vi.fn() } as never,
      allowByoTelephony() as never,
      {} as never,
      {} as never,
      makeAdmission() as never,
    );

    await service.disconnectNumber('workspace-1', 'number-1', 'user-1');

    expect(removeRouting).toHaveBeenCalledWith(
      expect.objectContaining({ trunkSid: 'TK1' }),
    );
    expect(prisma.telephonyPhoneNumber.delete).toHaveBeenCalledWith({ where: { id: 'number-1' } });
    expect(removeRouting.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.telephonyPhoneNumber.delete.mock.invocationCallOrder[0] as number,
    );
  });
});

function makeHandoffService(overrides?: {
  call?: Record<string, unknown> | null;
  dialError?: Error;
  /** Simulate a `handoff.requested` claim already held for this call. */
  claimHeld?: boolean;
  /** Simulate a `handoff.connected` event already written for this call. */
  alreadyConnected?: boolean;
}) {
  const call =
    overrides?.call === undefined
      ? {
          id: 'call-1',
          workspaceId: 'workspace-1',
          organizationId: 'org-1',
          agentId: 'agent-1',
          livekitRoomName: 'call-room-1',
          phoneNumber: {
            phoneNumberE164: '+917969007408',
            livekitConfig: { outboundTrunkId: 'trunk-out-1' },
          },
          agent: {
            specJson: { handoff: { enabled: true, target_phone: '8858901717', conditions: [] } },
            activeVersionId: null,
          },
        }
      : overrides.call;
  const prisma = {
    call: {
      findUnique: vi.fn(async () => call),
      update: vi.fn(async () => ({ id: 'call-1' })),
    },
    callEvent: {
      create: vi.fn(async (args: { data: { eventType: string; providerEventId?: string } }) => {
        if (overrides?.claimHeld && args.data.providerEventId) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        return { id: 'event-1' };
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => (overrides?.alreadyConnected ? { id: 'event-connected' } : null)),
    },
    agentVersion: { findUnique: vi.fn(async () => null) },
  };
  const livekit = {
    addSipParticipant: vi.fn(async () => {
      if (overrides?.dialError) throw overrides.dialError;
    }),
  };
  const service = new TelephonyService(
    prisma as never,
    livekit as never,
    {} as never,
    {} as never,
    { log: vi.fn(async () => undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    makeAdmission() as never,
  );
  return { service, prisma, livekit };
}

const HANDOFF_REQUEST = { callId: 'call-1', agentId: 'agent-1', summary: 'Deepak needs a refill.' };

/**
 * 2026-09-02: an agent with handoff enabled and a human number configured had
 * no way to reach that human; "transfer me to a person" got an apology. The
 * runtime now asks here to dial the human into the caller's room.
 */
describe('TelephonyService.dialHandoff', () => {
  it('dials the configured human into the room on the line the call arrived on', async () => {
    const { service, prisma, livekit } = makeHandoffService();

    await expect(service.dialHandoff(HANDOFF_REQUEST)).resolves.toEqual({
      connected: true,
      participantIdentity: 'sip-human-call-1',
      reason: null,
    });

    expect(livekit.addSipParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        outboundTrunkId: 'trunk-out-1',
        // A locally typed number is read in the country of the line.
        toNumber: '+918858901717',
        fromNumber: '+917969007408',
        roomName: 'call-room-1',
        participantIdentity: 'sip-human-call-1',
      }),
    );
    expect(prisma.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { outcome: 'human_transfer_completed' },
    });
    const eventTypes = prisma.callEvent.create.mock.calls.map(([args]) => args.data.eventType);
    expect(eventTypes).toEqual(['handoff.requested', 'handoff.connected']);
  });

  it('reports an unanswered dial as a reason instead of an error, and does not mark the call', async () => {
    const { service, prisma } = makeHandoffService({ dialError: new Error('sip: 480 Temporarily Unavailable') });

    const result = await service.dialHandoff(HANDOFF_REQUEST);

    expect(result.connected).toBe(false);
    expect(result.reason).toContain('480');
    expect(prisma.call.update).not.toHaveBeenCalled();
    const eventTypes = prisma.callEvent.create.mock.calls.map(([args]) => args.data.eventType);
    expect(eventTypes).toEqual(['handoff.requested', 'handoff.failed']);
    // The claim is released so the caller can ask for a person again.
    expect(prisma.callEvent.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-1', providerEventId: 'handoff:call-1' },
      data: { providerEventId: null },
    });
  });

  it('dials at most once per call: a retry or concurrent request while a dial is live is refused', async () => {
    const { service, livekit, prisma } = makeHandoffService({ claimHeld: true });

    await expect(service.dialHandoff(HANDOFF_REQUEST)).resolves.toEqual({
      connected: false,
      participantIdentity: null,
      reason: 'handoff_in_progress',
    });
    expect(livekit.addSipParticipant).not.toHaveBeenCalled();
    expect(prisma.callEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ providerEventId: 'handoff:call-1' }) }),
    );
  });

  it('answers a retry of an already-connected handoff with the success it was', async () => {
    const { service, livekit } = makeHandoffService({ claimHeld: true, alreadyConnected: true });

    await expect(service.dialHandoff(HANDOFF_REQUEST)).resolves.toEqual({
      connected: true,
      participantIdentity: 'sip-human-call-1',
      reason: null,
    });
    expect(livekit.addSipParticipant).not.toHaveBeenCalled();
  });

  it('will not dial for an agent that has handoff disabled, whatever the request says', async () => {
    const { service, livekit } = makeHandoffService({
      call: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        livekitRoomName: 'call-room-1',
        phoneNumber: {
          phoneNumberE164: '+917969007408',
          livekitConfig: { outboundTrunkId: 'trunk-out-1' },
        },
        agent: {
          specJson: { handoff: { enabled: false, target_phone: '+918858901717' } },
          activeVersionId: null,
        },
      },
    });

    await expect(service.dialHandoff(HANDOFF_REQUEST)).resolves.toMatchObject({
      connected: false,
      reason: 'handoff_disabled',
    });
    expect(livekit.addSipParticipant).not.toHaveBeenCalled();
  });

  it('refuses a call that is not bound to the requesting agent', async () => {
    const { service, livekit } = makeHandoffService();

    await expect(service.dialHandoff({ ...HANDOFF_REQUEST, agentId: 'agent-2' })).rejects.toMatchObject({
      status: 403,
    });
    expect(livekit.addSipParticipant).not.toHaveBeenCalled();
  });

  it('cannot transfer a call with no outbound trunk, such as a browser test', async () => {
    const { service, livekit } = makeHandoffService({
      call: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        livekitRoomName: 'test-room-1',
        phoneNumber: null,
        agent: { specJson: { handoff: { enabled: true, target_phone: '+918858901717' } }, activeVersionId: null },
      },
    });

    await expect(service.dialHandoff(HANDOFF_REQUEST)).resolves.toMatchObject({
      connected: false,
      reason: 'no_outbound_trunk',
    });
    expect(livekit.addSipParticipant).not.toHaveBeenCalled();
  });

  it('refuses a target that is not a dialable number', async () => {
    const { service, livekit } = makeHandoffService({
      call: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        livekitRoomName: 'call-room-1',
        phoneNumber: {
          phoneNumberE164: '+917969007408',
          livekitConfig: { outboundTrunkId: 'trunk-out-1' },
        },
        agent: { specJson: { handoff: { enabled: true, target_phone: 'ask for Vinod' } }, activeVersionId: null },
      },
    });

    await expect(service.dialHandoff(HANDOFF_REQUEST)).resolves.toMatchObject({
      connected: false,
      reason: 'invalid_target',
    });
    expect(livekit.addSipParticipant).not.toHaveBeenCalled();
  });
});
