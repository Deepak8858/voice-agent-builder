import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors';
import { LiveKitService } from './livekit.service';

describe('LiveKitService telephony operations', () => {
  it('creates inbound trunks with phone number metadata and optional SIP auth', async () => {
    const sipClient = {
      createSipInboundTrunk: vi.fn(async () => ({ sipTrunkId: 'trunk-in-1' })),
    };
    const service = new LiveKitService({ sipClient: sipClient as never });

    const result = await service.createInboundSipTrunk({
      workspaceId: 'workspace-1',
      phoneNumberId: 'number-1',
      phoneNumberE164: '+14155551234',
      provider: 'vobiz',
      authUsername: 'lk-user',
      authPassword: 'lk-pass',
    });

    expect(result.trunkId).toBe('trunk-in-1');
    expect(sipClient.createSipInboundTrunk).toHaveBeenCalledWith(
      'VoiceForge vobiz +14155551234 inbound',
      ['+14155551234'],
      expect.objectContaining({
        authUsername: 'lk-user',
        authPassword: 'lk-pass',
        metadata: JSON.stringify({
          workspaceId: 'workspace-1',
          phoneNumberId: 'number-1',
          provider: 'vobiz',
          direction: 'inbound',
        }),
      }),
    );
  });

  it('creates a LiveKit dispatch rule that dispatches the assigned VoiceForge agent', async () => {
    const sipClient = {
      createSipDispatchRule: vi.fn(async () => ({ sipDispatchRuleId: 'dispatch-1' })),
    };
    const service = new LiveKitService({ sipClient: sipClient as never });

    const result = await service.createDispatchRule({
      workspaceId: 'workspace-1',
      phoneNumberId: 'number-1',
      agentId: 'agent-1',
      trunkId: 'trunk-in-1',
      roomPrefix: 'call-number-1-',
      agentName: 'voiceforge-agent-agent-1',
      metadata: { provider: 'twilio', model: 'gpt-realtime-2' },
    });

    expect(result.dispatchRuleId).toBe('dispatch-1');
    expect(sipClient.createSipDispatchRule).toHaveBeenCalledWith(
      { type: 'individual', roomPrefix: 'call-number-1-' },
      expect.objectContaining({
        name: 'VoiceForge dispatch number-1',
        trunkIds: ['trunk-in-1'],
        metadata: JSON.stringify({
          workspaceId: 'workspace-1',
          phoneNumberId: 'number-1',
          agentId: 'agent-1',
          provider: 'twilio',
          model: 'gpt-realtime-2',
        }),
      }),
    );
    const options = (sipClient.createSipDispatchRule as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      roomConfig: { agents: Array<{ agentName: string; metadata: string }> };
    };
    expect(options.roomConfig.agents[0].agentName).toBe('voiceforge-agent-agent-1');
    expect(JSON.parse(options.roomConfig.agents[0].metadata)).toMatchObject({
      phoneNumberId: 'number-1',
      agentId: 'agent-1',
      model: 'gpt-realtime-2',
    });
  });

  it('starts outbound calls by creating a SIP participant in a LiveKit room', async () => {
    const sipClient = {
      createSipParticipant: vi.fn(async () => ({ participantId: 'sip-participant-1' })),
    };
    const service = new LiveKitService({ sipClient: sipClient as never });

    const result = await service.createOutboundCall({
      phoneNumberId: 'number-1',
      agentId: 'agent-1',
      outboundTrunkId: 'trunk-out-1',
      toNumber: '+14155559876',
      fromNumber: '+14155551234',
      roomName: 'call-number-1-outbound-abc',
    });

    expect(result.providerCallId).toBe('sip-participant-1');
    expect(result.roomName).toBe('call-number-1-outbound-abc');
    expect(sipClient.createSipParticipant).toHaveBeenCalledWith(
      'trunk-out-1',
      '+14155559876',
      'call-number-1-outbound-abc',
      expect.objectContaining({
        fromNumber: '+14155551234',
        participantIdentity: 'sip-number-1',
        participantMetadata: JSON.stringify({
          phoneNumberId: 'number-1',
          agentId: 'agent-1',
          direction: 'outbound',
        }),
        waitUntilAnswered: false,
      }),
    );
  });

  it('does not fall back to a global Vobiz SIP domain for outbound trunks', async () => {
    const sipClient = {
      createSipOutboundTrunk: vi.fn(),
    };
    const service = new LiveKitService({ sipClient: sipClient as never });

    await expect(
      service.createOutboundSipTrunk({
        workspaceId: 'workspace-1',
        phoneNumberId: 'number-1',
        phoneNumberE164: '+14155551234',
        provider: 'vobiz',
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(sipClient.createSipOutboundTrunk).not.toHaveBeenCalled();
  });
});
