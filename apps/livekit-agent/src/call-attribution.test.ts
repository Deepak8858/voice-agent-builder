import { describe, expect, it, vi } from 'vitest';
import { resolveCallAttribution } from './call-attribution';
import { InboundCallRefusedError } from './inbound-admit';

const INBOUND = {
  workspaceId: 'workspace-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  phoneNumberId: 'number-1',
  provider: 'twilio',
  direction: 'inbound' as const,
};

describe('resolveCallAttribution', () => {
  it('resolves the admitted call from Twilio CallSid and every tenant dimension', async () => {
    const findFirst = vi.fn(async () => ({ id: 'call-1', organizationId: 'org-1' }));

    await expect(
      resolveCallAttribution(
        INBOUND,
        { attributes: { 'sip.twilio.callSid': 'CA123' } },
        { findFirst },
      ),
    ).resolves.toEqual({ ...INBOUND, callId: 'call-1', providerCallId: 'CA123' });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        provider: 'twilio',
        providerCallId: 'CA123',
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        phoneNumberId: 'number-1',
        agentId: 'agent-1',
        direction: 'inbound',
      },
      select: { id: true, organizationId: true },
    });
  });

  it('fails closed instead of guessing when the SIP participant carries no call identity', async () => {
    const findFirst = vi.fn();

    await expect(resolveCallAttribution(INBOUND, { attributes: {} }, { findFirst })).rejects.toThrow(
      'neither sip.twilio.callSid nor sip.callID',
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('fails closed when nothing admitted the call and no admitter is configured', async () => {
    const findFirst = vi.fn(async () => null);

    await expect(
      resolveCallAttribution(
        INBOUND,
        { attributes: { 'sip.twilio.callSid': 'CA-never-admitted' } },
        { findFirst },
      ),
    ).rejects.toThrow('no admitted inbound call matches');
  });

  it('rejects a matched call that belongs to another organization', async () => {
    const findFirst = vi.fn(async () => ({ id: 'call-1', organizationId: 'org-other' }));

    await expect(
      resolveCallAttribution(
        INBOUND,
        { attributes: { 'sip.twilio.callSid': 'CA123' } },
        { findFirst },
      ),
    ).rejects.toThrow('belongs to another organization');
  });

  it('admits a SIP-delivered call keyed on LiveKit sip.callID when no webhook admitted it', async () => {
    const findFirst = vi.fn(async () => null);
    const admit = vi.fn(async () => ({ admitted: true, callId: 'call-sip', reason: null }));

    await expect(
      resolveCallAttribution(
        { ...INBOUND, provider: 'sip' },
        {
          identity: 'sip_participant_1',
          attributes: {
            'sip.callID': 'lk-call-99',
            'sip.phoneNumber': '+919000000001',
            'sip.trunkPhoneNumber': '+917969007408',
          },
        },
        { findFirst },
        admit,
      ),
    ).resolves.toEqual({
      ...INBOUND,
      provider: 'sip',
      callId: 'call-sip',
      providerCallId: 'lk-call-99',
    });

    expect(admit).toHaveBeenCalledWith({
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      phoneNumberId: 'number-1',
      agentId: 'agent-1',
      provider: 'sip',
      providerCallId: 'lk-call-99',
      fromNumber: '+919000000001',
      toNumber: '+917969007408',
      participantIdentity: 'sip_participant_1',
    });
  });

  it('does not admit twice when the Twilio webhook already admitted the call', async () => {
    const findFirst = vi.fn(async () => ({ id: 'call-1', organizationId: 'org-1' }));
    const admit = vi.fn();

    await expect(
      resolveCallAttribution(
        INBOUND,
        { attributes: { 'sip.twilio.callSid': 'CA123', 'sip.callID': 'lk-call-99' } },
        { findFirst },
        admit,
      ),
    ).resolves.toMatchObject({ callId: 'call-1', providerCallId: 'CA123' });
    expect(admit).not.toHaveBeenCalled();
  });

  it('reports a refused admission as a refusal, not a runtime fault', async () => {
    const findFirst = vi.fn(async () => null);
    const admit = vi.fn(async () => ({
      admitted: false,
      callId: 'call-sip',
      reason: 'insufficient_credits',
    }));

    await expect(
      resolveCallAttribution(INBOUND, { attributes: { 'sip.callID': 'lk-1' } }, { findFirst }, admit),
    ).rejects.toThrow(InboundCallRefusedError);
  });

  it('preserves outbound call ids without querying SIP identity', async () => {
    const findFirst = vi.fn();
    const metadata = { ...INBOUND, direction: 'outbound' as const, callId: 'call-outbound' };

    await expect(resolveCallAttribution(metadata, null, { findFirst })).resolves.toEqual(metadata);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
