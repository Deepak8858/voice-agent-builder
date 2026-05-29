import { describe, expect, it, vi } from 'vitest';
import { VobizProviderAdapter } from './vobiz.provider';

describe('VobizProviderAdapter', () => {
  it('lists account phone numbers using the documented partner number inventory endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            number: '+912271264217',
            trunk_id: 'trunk-1',
            status: 'active',
            application_name: 'Main IVR',
          },
        ],
      }),
    }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'partner-id',
      authToken: 'partner-token',
      customerAuthId: 'MA_customer',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.vobiz.ai/api/v1/partner/accounts/MA_customer/numbers?page=1&per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Auth-ID': 'partner-id',
          'X-Auth-Token': 'partner-token',
          Accept: 'application/json',
        }),
      }),
    );
    expect(numbers).toEqual([
      expect.objectContaining({
        providerNumberId: 'trunk-1',
        phoneNumberE164: '+912271264217',
        friendlyName: 'Main IVR',
        capabilities: expect.objectContaining({ voice: true, inbound: true }),
      }),
    ]);
  });

  it('lists account trunks without treating the trunk ID as an E.164 phone number', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        objects: [
          {
            trunk_id: 'trunk-console-1',
            name: 'Console trunk',
            trunk_domain: 'trunk-console-1.sip.vobiz.ai',
            trunk_status: 'active',
            trunk_direction: 'inbound',
          },
        ],
      }),
    }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'auth-id',
      authToken: 'auth-token',
    });

    expect(numbers).toEqual([
      expect.objectContaining({
        providerNumberId: 'trunk-console-1',
        phoneNumberE164: null,
        friendlyName: 'Console trunk',
        capabilities: expect.objectContaining({ voice: true, inbound: true, outbound: false }),
        metadata: expect.objectContaining({
          sipTrunkId: 'trunk-console-1',
          sipTrunkDomain: 'trunk-console-1.sip.vobiz.ai',
          requiresPhoneNumber: true,
        }),
      }),
    ]);
  });

  it('updates a Vobiz inbound trunk destination to the LiveKit SIP host without the sip prefix', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const result = await adapter.configureInboundRouting({
      credentials: {
        provider: 'vobiz',
        authId: 'auth-id',
        authToken: 'auth-token',
      },
      phoneNumber: {
        id: 'number-1',
        provider: 'vobiz',
        providerNumberId: 'trunk-1',
        phoneNumberE164: '+912271264217',
        sipTrunkId: 'trunk-1',
      },
      livekitSipUri: 'sip:tenant.sip.livekit.cloud',
      fallbackWebhookUrl: 'https://app.example.com/fallback',
      statusCallbackUrl: 'https://app.example.com/status',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.vobiz.ai/api/v1/Account/auth-id/trunks/trunk-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'X-Auth-ID': 'auth-id',
          'X-Auth-Token': 'auth-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          inbound_destination: 'tenant.sip.livekit.cloud',
          webhook_url: 'https://app.example.com/status',
          webhook_method: 'POST',
        }),
      }),
    );
    expect(result.status).toBe('configured');
  });
});
