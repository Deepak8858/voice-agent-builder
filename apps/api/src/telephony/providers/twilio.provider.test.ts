import { describe, expect, it } from 'vitest';
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
});
