import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { VobizProviderAdapter } from './vobiz.provider';

const NUMBERS_RESPONSE = {
  items: [
    {
      id: 'aabbccdd-1234-5678-90ab-cdef12345678',
      account_id: 'MA_customer',
      e164: '+912271264217',
      country: 'IN',
      region: 'Mumbai',
      capabilities: { voice: true, sms: false },
      status: 'active',
      application_id: '20577609616603585',
      voice_enabled: true,
    },
  ],
  page: 1,
  per_page: 100,
  total: 1,
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function errorResponse(status: number, body = '') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

describe('VobizProviderAdapter', () => {
  it('lists owned numbers from the documented account numbers endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(NUMBERS_RESPONSE));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'MA_customer',
      authToken: 'auth-token',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.vobiz.ai/api/v1/Account/MA_customer/numbers?page=1&per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Auth-ID': 'MA_customer',
          'X-Auth-Token': 'auth-token',
          Accept: 'application/json',
        }),
      }),
    );
    expect(numbers).toEqual([
      expect.objectContaining({
        providerNumberId: '+912271264217',
        phoneNumberE164: '+912271264217',
        capabilities: expect.objectContaining({ voice: true, inbound: true }),
        metadata: expect.objectContaining({
          providerNumberUuid: 'aabbccdd-1234-5678-90ab-cdef12345678',
          accountId: 'MA_customer',
          applicationId: '20577609616603585',
          requiresPhoneNumber: false,
        }),
      }),
    ]);
  });

  it('falls back to the account numbers endpoint when the partner inventory is not accessible', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(403, '{"error":{"code":403,"message":"Partner access disabled"}}'))
      .mockResolvedValueOnce(jsonResponse(NUMBERS_RESPONSE));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'PA_partner',
      authToken: 'partner-token',
      customerAuthId: 'MA_customer',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.vobiz.ai/api/v1/partner/accounts/MA_customer/numbers?page=1&per_page=100',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.vobiz.ai/api/v1/Account/MA_customer/numbers?page=1&per_page=100',
      expect.anything(),
    );
    expect(numbers).toHaveLength(1);
  });

  it('falls back to trunks when the account owns no API-visible numbers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], page: 1, per_page: 100, total: 0 }))
      .mockResolvedValueOnce(
        jsonResponse({
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
      );
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'auth-id',
      authToken: 'auth-token',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.vobiz.ai/api/v1/Account/auth-id/trunks?limit=100',
      expect.anything(),
    );
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

  it('reads trunks from the customer account when Partner credentials select one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(403, 'Partner access disabled'))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(jsonResponse({ objects: [{ trunk_id: 'customer-trunk' }] }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'PA_partner',
      authToken: 'partner-token',
      customerAuthId: 'MA_customer',
    });

    // The partner account authenticates the request, but the trunks of interest
    // belong to the customer sub-account being synced.
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.vobiz.ai/api/v1/Account/MA_customer/trunks?limit=100',
      expect.anything(),
    );
    expect(numbers).toEqual([expect.objectContaining({ providerNumberId: 'customer-trunk' })]);
  });

  it('falls through to the next source when a request rejects outright', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ objects: [{ trunk_id: 'trunk-after-network-error' }] }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'auth-id',
      authToken: 'auth-token',
    });

    expect(numbers).toEqual([
      expect.objectContaining({ providerNumberId: 'trunk-after-network-error' }),
    ]);
  });

  it('falls through to the next source when a response is not valid JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
        text: async () => '<html>gateway</html>',
      })
      .mockResolvedValueOnce(jsonResponse({ objects: [{ trunk_id: 'trunk-after-bad-json' }] }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'auth-id',
      authToken: 'auth-token',
    });

    expect(numbers).toEqual([
      expect.objectContaining({ providerNumberId: 'trunk-after-bad-json' }),
    ]);
  });

  it('treats a non-list numbers payload as a failed source instead of throwing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: { e164: '+912271264217' } }))
      .mockResolvedValueOnce(jsonResponse({ objects: [{ trunk_id: 'trunk-after-bad-shape' }] }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'auth-id',
      authToken: 'auth-token',
    });

    expect(numbers).toEqual([
      expect.objectContaining({ providerNumberId: 'trunk-after-bad-shape' }),
    ]);
  });

  it('reports every failure, including malformed payloads, when no source yields numbers', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ objects: 'not-a-list' }));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    await expect(
      adapter.listPhoneNumbers({
        provider: 'vobiz',
        authId: 'auth-id',
        authToken: 'auth-token',
      }),
    ).rejects.toThrow(/socket hang up[\s\S]*trunks were not a list/);
  });

  it('skips trunks that have no usable trunk ID', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ objects: [{ name: 'no id' }, { trunk_id: 'trunk-usable' }] }),
      );
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    const numbers = await adapter.listPhoneNumbers({
      provider: 'vobiz',
      authId: 'auth-id',
      authToken: 'auth-token',
    });

    expect(numbers).toEqual([expect.objectContaining({ providerNumberId: 'trunk-usable' })]);
  });

  it('surfaces the upstream Vobiz error body when every number source fails', async () => {
    const fetchMock = vi.fn(async () => errorResponse(401, '{"error":{"code":401,"message":"Invalid authentication credentials"}}'));
    const adapter = new VobizProviderAdapter({ fetch: fetchMock as never });

    await expect(
      adapter.listPhoneNumbers({
        provider: 'vobiz',
        authId: 'auth-id',
        authToken: 'auth-token',
      }),
    ).rejects.toThrow(/Invalid authentication credentials/);
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

  it('rejects unsigned webhooks when a Vobiz webhook secret is configured', async () => {
    const adapter = new VobizProviderAdapter();

    await expect(
      adapter.validateWebhookSignature({
        secret: 'vobiz-webhook-secret',
        headers: {},
        url: 'https://app.example.com/api/v1/telephony/vobiz/status/number-1',
        body: { call_id: 'call-1', status: 'completed' },
        rawBody: '{"call_id":"call-1","status":"completed"}',
      }),
    ).resolves.toBe(false);
  });

  it('validates Vobiz HMAC signatures with timestamp and raw request body', async () => {
    const adapter = new VobizProviderAdapter();
    const secret = 'vobiz-webhook-secret';
    const rawBody = '{"call_id":"call-1","status":"completed"}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    await expect(
      adapter.validateWebhookSignature({
        secret,
        headers: {
          'x-vobiz-signature': signature,
          'x-vobiz-timestamp': timestamp,
        },
        url: 'https://app.example.com/api/v1/telephony/vobiz/status/number-1',
        body: { call_id: 'call-1', status: 'completed' },
        rawBody,
      }),
    ).resolves.toBe(true);
  });

  it('rejects Vobiz signatures that do not match the raw request body', async () => {
    const adapter = new VobizProviderAdapter();
    const secret = 'vobiz-webhook-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.{"call_id":"call-1","status":"completed"}`)
      .digest('hex');

    await expect(
      adapter.validateWebhookSignature({
        secret,
        headers: {
          'x-vobiz-signature': signature,
          'x-vobiz-timestamp': timestamp,
        },
        url: 'https://app.example.com/api/v1/telephony/vobiz/status/number-1',
        body: { call_id: 'call-1', status: 'failed' },
        rawBody: '{"call_id":"call-1","status":"failed"}',
      }),
    ).resolves.toBe(false);
  });
});
