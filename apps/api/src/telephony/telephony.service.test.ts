import { describe, expect, it, vi } from 'vitest';
import { ComplianceBlockedError } from '../common/errors';
import { TelephonyService } from './telephony.service';

function makePrisma() {
  return {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'workspace-1', organizationId: 'org-1' })),
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
      upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
        id: 'lk-config-1',
        ...create,
        ...update,
      })),
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
      check: vi.fn(async () => ({ id: 'check-1', status: 'passed', reasons: [], contact_id: null })),
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
        agentName: 'voiceforge-agent-agent-1',
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
        buildLiveKitDialTwiml: vi.fn(() => '<Response><Dial><Sip>sip:tenant.sip.livekit.cloud</Sip></Dial></Response>'),
      } as never,
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
      { encryptJson: vi.fn(), decryptJson: vi.fn() } as never,
      audit as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.importNumbers('workspace-1', 'user-1', {
      connection_id: 'connection-1',
      numbers: [
        {
          provider_number_id: 'trunk-console-1',
          phone_number: '+912271264217',
          friendly_name: 'Console trunk',
          capabilities: { voice: true, inbound: true, outbound: false },
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
});
