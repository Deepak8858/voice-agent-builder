import { describe, expect, it, vi } from 'vitest';
import { resolveCallAttribution } from './call-attribution';

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

  it('fails closed instead of guessing when the SIP participant has no Twilio CallSid', async () => {
    const findFirst = vi.fn();

    await expect(resolveCallAttribution(INBOUND, { attributes: {} }, { findFirst })).rejects.toThrow(
      'missing sip.twilio.callSid',
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects a provider call identity that does not match the dispatched tenant', async () => {
    const findFirst = vi.fn(async () => null);

    await expect(
      resolveCallAttribution(
        INBOUND,
        { attributes: { 'sip.twilio.callSid': 'CA-other-tenant' } },
        { findFirst },
      ),
    ).rejects.toThrow('no admitted inbound call matches');
  });

  it('preserves outbound call ids without querying SIP identity', async () => {
    const findFirst = vi.fn();
    const metadata = { ...INBOUND, direction: 'outbound' as const, callId: 'call-outbound' };

    await expect(resolveCallAttribution(metadata, null, { findFirst })).resolves.toEqual(metadata);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
