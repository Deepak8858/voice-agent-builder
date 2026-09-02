import { describe, expect, it } from 'vitest';
import type { TwilioConnectionCredentials } from '@voiceforge/shared';
import { TwilioProviderAdapter } from './twilio.provider';

describe('TwilioProviderAdapter', () => {
  it('generates TwiML that dials the LiveKit SIP URI for inbound calls', () => {
    const adapter = new TwilioProviderAdapter();

    const twiml = adapter.buildLiveKitDialTwiml('sip:tenant.sip.livekit.cloud');

    expect(twiml).toContain('<Response>');
    expect(twiml).toContain('<Dial>');
    expect(twiml).toContain('<Sip>sip:tenant.sip.livekit.cloud</Sip>');
    expect(twiml).not.toContain('&lt;Sip&gt;');
  });

  it('returns a safe fallback TwiML response when routing is unavailable', () => {
    const adapter = new TwilioProviderAdapter();

    const twiml = adapter.buildFallbackTwiml();

    expect(twiml).toContain('Sorry, this voice agent is not available right now.');
    expect(twiml).toContain('<Hangup/>');
  });

  it('updates Twilio number routing with voice, fallback, and status webhooks', async () => {
    let requestBody = '';
    const adapter = new TwilioProviderAdapter({
      fetch: async (_url, init) => {
        requestBody = String(init?.body ?? '');
        return new Response('{}', { status: 200 });
      },
    });
    const credentials: TwilioConnectionCredentials = {
      provider: 'twilio',
      accountSid: 'AC123',
      authToken: 'auth-token',
    };

    await adapter.configureInboundRouting({
      credentials,
      phoneNumber: {
        id: 'number-1',
        provider: 'twilio',
        providerNumberId: 'PN123',
        phoneNumberE164: '+14155551234',
      },
      livekitSipUri: 'sip:tenant.sip.livekit.cloud',
      fallbackWebhookUrl: 'https://vocal.devdeepak.me/api/v1/telephony/twilio/fallback/number-1',
      statusCallbackUrl: 'https://vocal.devdeepak.me/api/v1/telephony/twilio/status/number-1',
    });

    const params = new URLSearchParams(requestBody);
    expect(params.get('VoiceUrl')).toBe('https://vocal.devdeepak.me/api/v1/telephony/twilio/voice/number-1');
    expect(params.get('VoiceFallbackUrl')).toBe('https://vocal.devdeepak.me/api/v1/telephony/twilio/fallback/number-1');
    expect(params.get('VoiceMethod')).toBe('POST');
    expect(params.get('VoiceFallbackMethod')).toBe('POST');
    expect(params.get('StatusCallback')).toBe('https://vocal.devdeepak.me/api/v1/telephony/twilio/status/number-1');
    expect(params.get('StatusCallbackMethod')).toBe('POST');
  });

  it('creates the trunk, its origination URL and its credentials on first connect', async () => {
    const calls: string[] = [];
    const adapter = new TwilioProviderAdapter({
      fetch: async (url, init) => {
        const target = `${init?.method ?? 'GET'} ${String(url)}`;
        calls.push(target);
        if (target.startsWith('GET') && target.includes('/Trunks?')) {
          return json({ trunks: [] });
        }
        if (target.includes('/OriginationUrls') && target.startsWith('GET')) {
          return json({ origination_urls: [] });
        }
        if (target.includes('/Trunks/TK1/OriginationUrls')) return json({ sid: 'OU1' });
        if (target.endsWith('/Trunks')) {
          return json({ sid: 'TK1', friendly_name: 'VoiceForge', domain_name: 'vf-abc.pstn.twilio.com' });
        }
        if (target.includes('CredentialLists.json')) return json({ sid: 'CL1' });
        return json({});
      },
    });

    const trunk = await adapter.ensureSipTrunk({
      credentials: CREDENTIALS,
      originationSipUri: 'sip:tenant.sip.livekit.cloud;transport=tcp',
    });

    expect(trunk).toMatchObject({
      trunkSid: 'TK1',
      domainName: 'vf-abc.pstn.twilio.com',
      originationUrlSid: 'OU1',
      credentialListSid: 'CL1',
    });
    expect(trunk.username).toMatch(/^vf_[0-9a-f]{8}$/);
    // Twilio never reads a password back, so the only chance to keep it is now.
    expect(trunk.password).toHaveLength(24);
    expect(calls.some((call) => call.includes('/Credentials.json'))).toBe(true);
    expect(calls.some((call) => call.endsWith('/Trunks/TK1/CredentialLists'))).toBe(true);
  });

  it('reuses an existing trunk, origination URL and credential without creating anything', async () => {
    const calls: string[] = [];
    const adapter = new TwilioProviderAdapter({
      fetch: async (url, init) => {
        const target = `${init?.method ?? 'GET'} ${String(url)}`;
        calls.push(target);
        if (target.includes('/OriginationUrls')) {
          return json({
            origination_urls: [
              { sid: 'OU1', sip_url: 'sip:tenant.sip.livekit.cloud;transport=tcp' },
            ],
          });
        }
        return json({
          trunks: [
            { sid: 'TK1', friendly_name: 'VoiceForge', domain_name: 'vf-abc.pstn.twilio.com' },
          ],
        });
      },
    });

    const trunk = await adapter.ensureSipTrunk({
      credentials: CREDENTIALS,
      originationSipUri: 'sip:tenant.sip.livekit.cloud;transport=tcp',
      existingUsername: 'vf_deadbeef',
    });

    expect(trunk).toMatchObject({
      trunkSid: 'TK1',
      originationUrlSid: 'OU1',
      username: 'vf_deadbeef',
      password: null,
    });
    expect(calls.every((call) => call.startsWith('GET'))).toBe(true);
  });

  it('reuses the recorded trunk by sid, never the first one that shares our name', async () => {
    const calls: string[] = [];
    const adapter = new TwilioProviderAdapter({
      fetch: async (url, init) => {
        const target = `${init?.method ?? 'GET'} ${String(url)}`;
        calls.push(target);
        if (target.includes('/OriginationUrls')) {
          return json({
            origination_urls: [
              { sid: 'OU9', sip_url: 'sip:tenant.sip.livekit.cloud;transport=tcp' },
            ],
          });
        }
        return json({ sid: 'TK9', friendly_name: 'VoiceForge', domain_name: 'vf-nine.pstn.twilio.com' });
      },
    });

    const trunk = await adapter.ensureSipTrunk({
      credentials: CREDENTIALS,
      originationSipUri: 'sip:tenant.sip.livekit.cloud;transport=tcp',
      existingUsername: 'vf_deadbeef',
      existingTrunkSid: 'TK9',
    });

    expect(trunk).toMatchObject({ trunkSid: 'TK9', domainName: 'vf-nine.pstn.twilio.com' });
    // The customer's own trunk list is never consulted, so a same-named trunk of
    // theirs cannot be adopted.
    expect(calls.some((call) => call.includes('/Trunks?'))).toBe(false);
    expect(calls[0]).toBe('GET https://trunking.twilio.com/v1/Trunks/TK9');
  });

  it('falls back to a fresh trunk when the recorded one was deleted at Twilio', async () => {
    const calls: string[] = [];
    const adapter = new TwilioProviderAdapter({
      fetch: async (url, init) => {
        const target = `${init?.method ?? 'GET'} ${String(url)}`;
        calls.push(target);
        if (target === 'GET https://trunking.twilio.com/v1/Trunks/TKGONE') {
          return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        }
        if (target.includes('/Trunks?')) return json({ trunks: [] });
        if (target.includes('/OriginationUrls') && target.startsWith('GET')) {
          return json({ origination_urls: [] });
        }
        if (target.includes('/OriginationUrls')) return json({ sid: 'OU2' });
        if (target.endsWith('/Trunks')) {
          return json({ sid: 'TK2', friendly_name: 'VoiceForge', domain_name: 'vf-two.pstn.twilio.com' });
        }
        return json({});
      },
    });

    const trunk = await adapter.ensureSipTrunk({
      credentials: CREDENTIALS,
      originationSipUri: 'sip:tenant.sip.livekit.cloud;transport=tcp',
      existingUsername: 'vf_deadbeef',
      existingTrunkSid: 'TKGONE',
    });

    expect(trunk.trunkSid).toBe('TK2');
    expect(calls.some((call) => call.includes('/Trunks?'))).toBe(true);
  });

  it('fails instead of adopting a same-named trunk when the recorded lookup errors', async () => {
    const calls: string[] = [];
    const adapter = new TwilioProviderAdapter({
      fetch: async (url, init) => {
        const target = `${init?.method ?? 'GET'} ${String(url)}`;
        calls.push(target);
        // A revoked token, not a deleted trunk.
        if (target === 'GET https://trunking.twilio.com/v1/Trunks/TK9') {
          return new Response(JSON.stringify({ message: 'authenticate' }), { status: 401 });
        }
        return json({});
      },
    });

    await expect(
      adapter.ensureSipTrunk({
        credentials: CREDENTIALS,
        originationSipUri: 'sip:tenant.sip.livekit.cloud;transport=tcp',
        existingUsername: 'vf_deadbeef',
        existingTrunkSid: 'TK9',
      }),
    ).rejects.toThrow();

    // The customer's trunk list is never listed, so their own VoiceForge trunk
    // cannot be repointed at our media plane because of a transient failure.
    expect(calls.some((call) => call.includes('/Trunks?'))).toBe(false);
  });

  it('attaches the number to the trunk instead of rewriting webhooks, and tolerates a re-attach', async () => {
    const calls: string[] = [];
    const adapter = new TwilioProviderAdapter({
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        // Twilio answers 409 when the number is already on the trunk, which is
        // the state a reconfigure wants.
        return new Response(JSON.stringify({ message: 'already attached', status: 409 }), {
          status: 409,
        });
      },
    });

    const result = await adapter.configureInboundRouting({
      credentials: CREDENTIALS,
      phoneNumber: NUMBER,
      livekitSipUri: 'sip:tenant.sip.livekit.cloud',
      trunkSid: 'TK1',
      fallbackWebhookUrl: 'https://example.test/fallback',
      statusCallbackUrl: 'https://example.test/status',
    });

    expect(result).toMatchObject({ status: 'configured', providerRoutingId: 'TK1' });
    expect(calls).toEqual([
      'POST https://trunking.twilio.com/v1/Trunks/TK1/PhoneNumbers',
    ]);
  });

  it('releases the number from the trunk when routing is removed', async () => {
    const calls: string[] = [];
    const adapter = new TwilioProviderAdapter({
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        // `null`, not '': a 204 with a body is not constructible, and the old
        // blanket catch in removeRouting hid that this mock never worked.
        return new Response(null, { status: 204 });
      },
    });

    await adapter.removeRouting({ credentials: CREDENTIALS, phoneNumber: NUMBER, trunkSid: 'TK1' });

    expect(calls).toEqual([
      'DELETE https://trunking.twilio.com/v1/Trunks/TK1/PhoneNumbers/PN123',
    ]);
  });

  it('treats a 404 release as done but reports every other release failure', async () => {
    const gone = new TwilioProviderAdapter({
      fetch: async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
    });
    await expect(
      gone.removeRouting({ credentials: CREDENTIALS, phoneNumber: NUMBER, trunkSid: 'TK1' }),
    ).resolves.toBeUndefined();

    const broken = new TwilioProviderAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: 'Authenticate' }), { status: 401 }),
    });
    // Swallowing this would leave the number attached to a trunk whose routing
    // is being deleted, and nothing would say so.
    await expect(
      broken.removeRouting({ credentials: CREDENTIALS, phoneNumber: NUMBER, trunkSid: 'TK1' }),
    ).rejects.toThrow(/Authenticate/);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const CREDENTIALS: TwilioConnectionCredentials = {
  provider: 'twilio',
  accountSid: 'AC123',
  authToken: 'auth-token',
};

const NUMBER = {
  id: 'number-1',
  provider: 'twilio' as const,
  providerNumberId: 'PN123',
  phoneNumberE164: '+14155551234',
};
