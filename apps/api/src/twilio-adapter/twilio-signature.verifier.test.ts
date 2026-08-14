import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { TwilioSignatureVerifier } from './twilio-signature.verifier';
import { env } from '../config/env';

const AUTH_TOKEN = 'test-auth-token-value';
const WEBHOOK_ORIGIN = 'https://api.example.com';
const PATH = '/api/v1/voice/webhook/inbound';

const PAYLOAD = {
  CallSid: 'CA123',
  From: '+15557654321',
  To: '+15551234567',
};

/** Signs exactly as Twilio does, so the verifier is tested against real output. */
function sign(url: string, body: Record<string, unknown>): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, body as Record<string, string>);
}

describe('TwilioSignatureVerifier', () => {
  const original = {
    authToken: env.TWILIO_AUTH_TOKEN,
    webhookUrl: env.TWILIO_TWIML_WEBHOOK_URL,
  };

  beforeEach(() => {
    (env as { TWILIO_AUTH_TOKEN?: string }).TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    (env as { TWILIO_TWIML_WEBHOOK_URL?: string }).TWILIO_TWIML_WEBHOOK_URL = WEBHOOK_ORIGIN;
  });

  afterEach(() => {
    (env as { TWILIO_AUTH_TOKEN?: string }).TWILIO_AUTH_TOKEN = original.authToken;
    (env as { TWILIO_TWIML_WEBHOOK_URL?: string }).TWILIO_TWIML_WEBHOOK_URL = original.webhookUrl;
  });

  it('accepts a delivery signed for the public request URL', async () => {
    const verifier = new TwilioSignatureVerifier();
    const signature = sign(`${WEBHOOK_ORIGIN}${PATH}`, PAYLOAD);

    await expect(
      verifier.assertValidSignature(
        { headers: { 'x-twilio-signature': signature }, originalUrl: PATH, body: PAYLOAD },
        'voice.inbound',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a delivery with no signature header', async () => {
    const verifier = new TwilioSignatureVerifier();

    await expect(
      verifier.assertValidSignature({ headers: {}, originalUrl: PATH, body: PAYLOAD }, 'voice.inbound'),
    ).rejects.toThrow('Missing Twilio webhook signature.');
  });

  it('rejects a signature computed over a different body', async () => {
    const verifier = new TwilioSignatureVerifier();
    const signature = sign(`${WEBHOOK_ORIGIN}${PATH}`, { ...PAYLOAD, To: '+19998887777' });

    await expect(
      verifier.assertValidSignature(
        { headers: { 'x-twilio-signature': signature }, originalUrl: PATH, body: PAYLOAD },
        'voice.inbound',
      ),
    ).rejects.toThrow('Invalid Twilio webhook signature.');
  });

  it('rejects a signature computed over a different host, so a forged Host header cannot help an attacker', async () => {
    const verifier = new TwilioSignatureVerifier();
    const signature = sign(`https://attacker.example.net${PATH}`, PAYLOAD);

    await expect(
      verifier.assertValidSignature(
        { headers: { 'x-twilio-signature': signature }, originalUrl: PATH, body: PAYLOAD },
        'voice.inbound',
      ),
    ).rejects.toThrow('Invalid Twilio webhook signature.');
  });

  it('rejects every delivery when no signing token is configured', async () => {
    (env as { TWILIO_AUTH_TOKEN?: string }).TWILIO_AUTH_TOKEN = undefined;
    const verifier = new TwilioSignatureVerifier();
    const signature = sign(`${WEBHOOK_ORIGIN}${PATH}`, PAYLOAD);

    await expect(
      verifier.assertValidSignature(
        { headers: { 'x-twilio-signature': signature }, originalUrl: PATH, body: PAYLOAD },
        'voice.inbound',
      ),
    ).rejects.toThrow('Twilio webhook signing token is not configured.');
  });
});
