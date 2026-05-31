import twilio from 'twilio';
import type { ProviderCredentials } from '@voiceforge/shared';
import { AppError } from '../../common/errors';
import type {
  ConnectedPhoneNumber,
  PhoneNumberProviderAdapter,
  ProviderPhoneNumber,
  ProviderRoutingResult,
  ProviderValidationResult,
  ValidateWebhookParams,
} from './provider.types';

interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

interface TwilioIncomingNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string;
  capabilities?: Record<string, unknown>;
  voice_url?: string | null;
  status_callback?: string | null;
}

export class TwilioProviderAdapter implements PhoneNumberProviderAdapter {
  readonly provider = 'twilio' as const;
  private readonly fetchImpl: FetchLike;

  constructor(deps: { fetch?: FetchLike } = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async validateCredentials(credentials: ProviderCredentials): Promise<ProviderValidationResult> {
    const twilioCredentials = this.assertCredentials(credentials);
    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioCredentials.accountSid}.json`,
      { headers: { Authorization: this.authHeader(twilioCredentials) } },
    );
    if (!response.ok) {
      return { valid: false, message: `Twilio credentials failed with HTTP ${response.status}` };
    }
    const data = (await response.json().catch(() => ({}))) as { sid?: string };
    return { valid: true, providerAccountId: data.sid ?? twilioCredentials.accountSid };
  }

  async listPhoneNumbers(credentials: ProviderCredentials): Promise<ProviderPhoneNumber[]> {
    const twilioCredentials = this.assertCredentials(credentials);
    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioCredentials.accountSid}/IncomingPhoneNumbers.json?PageSize=100`,
      { headers: { Authorization: this.authHeader(twilioCredentials) } },
    );
    if (!response.ok) {
      throw new AppError('PROVIDER_CREDENTIALS_INVALID', `Twilio number sync failed with HTTP ${response.status}`, 400);
    }
    const data = (await response.json()) as { incoming_phone_numbers?: TwilioIncomingNumber[] };
    return (data.incoming_phone_numbers ?? [])
      .filter((number) => Boolean(number.capabilities?.voice))
      .map((number) => ({
        providerNumberId: number.sid,
        phoneNumberE164: number.phone_number,
        friendlyName: number.friendly_name ?? number.phone_number,
        capabilities: number.capabilities ?? { voice: true },
        metadata: {
          previousVoiceUrl: number.voice_url ?? null,
          previousStatusCallback: number.status_callback ?? null,
        },
      }));
  }

  async getPhoneNumber(credentials: ProviderCredentials, providerNumberId: string): Promise<ProviderPhoneNumber> {
    const numbers = await this.listPhoneNumbers(credentials);
    const number = numbers.find((item) => item.providerNumberId === providerNumberId);
    if (!number) {
      throw new AppError('TELEPHONY_NOT_FOUND', 'Twilio phone number was not found in this account.', 404);
    }
    return number;
  }

  async configureInboundRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    livekitSipUri: string;
    fallbackWebhookUrl: string;
    statusCallbackUrl: string;
  }): Promise<ProviderRoutingResult> {
    const twilioCredentials = this.assertCredentials(params.credentials);
    if (!params.phoneNumber.providerNumberId) {
      return {
        status: 'manual_required',
        message: 'Twilio number SID is missing. Configure the Voice webhook manually.',
        manualInstructions: { twiml: this.buildLiveKitDialTwiml(params.livekitSipUri) },
      };
    }
    const formData = new URLSearchParams({
      VoiceUrl: params.fallbackWebhookUrl.replace('/fallback/', '/voice/'),
      VoiceMethod: 'POST',
      VoiceFallbackUrl: params.fallbackWebhookUrl,
      VoiceFallbackMethod: 'POST',
      StatusCallback: params.statusCallbackUrl,
      StatusCallbackMethod: 'POST',
    });
    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioCredentials.accountSid}/IncomingPhoneNumbers/${params.phoneNumber.providerNumberId}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(twilioCredentials),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      },
    );
    if (!response.ok) {
      return {
        status: 'manual_required',
        message: `Twilio routing update failed with HTTP ${response.status}.`,
        manualInstructions: { twiml: this.buildLiveKitDialTwiml(params.livekitSipUri) },
      };
    }
    return { status: 'configured', providerRoutingId: params.phoneNumber.providerNumberId };
  }

  async removeRouting(_params: { credentials: ProviderCredentials; phoneNumber: ConnectedPhoneNumber }): Promise<void> {
    return undefined;
  }

  async validateWebhookSignature(params: ValidateWebhookParams): Promise<boolean> {
    const token = params.secret;
    const signature = header(params.headers, 'x-twilio-signature');
    if (!token || !signature) return false;
    return twilio.validateRequest(token, signature, params.url, params.body);
  }

  buildLiveKitDialTwiml(livekitSipUri: string): string {
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial();
    dial.sip(livekitSipUri);
    return response.toString();
  }

  buildFallbackTwiml(): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say('Sorry, this voice agent is not available right now. Please try again later.');
    response.hangup();
    return response.toString();
  }

  private assertCredentials(credentials: ProviderCredentials) {
    if (credentials.provider !== 'twilio') {
      throw new AppError('PROVIDER_CREDENTIALS_INVALID', 'Expected Twilio credentials.', 400);
    }
    return credentials;
  }

  private authHeader(credentials: { accountSid: string; authToken: string }): string {
    return `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`;
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const exact = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(exact)) return exact[0] ?? null;
  return exact ?? null;
}
