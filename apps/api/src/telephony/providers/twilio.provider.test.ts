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
});
