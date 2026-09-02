import twilio from 'twilio';
import { randomBytes } from 'node:crypto';
import type { ProviderCredentials } from '@voiceforge/shared';
import { AppError } from '../../common/errors';
import type {
  ConnectedPhoneNumber,
  PhoneNumberProviderAdapter,
  ProviderPhoneNumber,
  ProviderRoutingResult,
  ProviderSipTrunk,
  ProviderValidationResult,
  ValidateWebhookParams,
} from './provider.types';

const TRUNKING_API = 'https://trunking.twilio.com/v1';
const VOICE_API = 'https://api.twilio.com/2010-04-01';

/** Name of the trunk this platform owns inside the customer's Twilio account. */
const TRUNK_FRIENDLY_NAME = 'VoiceForge';

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
    trunkSid?: string | null;
  }): Promise<ProviderRoutingResult> {
    const twilioCredentials = this.assertCredentials(params.credentials);
    if (params.trunkSid && params.phoneNumber.providerNumberId) {
      // Attaching the number to the trunk moves it off Programmable Voice, so the
      // voice webhook stops being in the path - which is the point: that webhook
      // could not tell the media plane which number had been called.
      await this.attachNumberToTrunk(
        twilioCredentials,
        params.trunkSid,
        params.phoneNumber.providerNumberId,
      );
      return { status: 'configured', providerRoutingId: params.trunkSid };
    }
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

  /**
   * Returns the number to Programmable Voice by taking it off the trunk.
   *
   * A number left on the trunk after its config is deleted keeps sending calls
   * to a room nothing dispatches into, so the caller hears silence instead of
   * whatever the customer configures next.
   */
  async removeRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    trunkSid?: string | null;
  }): Promise<void> {
    if (!params.trunkSid || !params.phoneNumber.providerNumberId) return;
    const credentials = this.assertCredentials(params.credentials);
    await this.trunkingRequest(
      credentials,
      'DELETE',
      `/Trunks/${params.trunkSid}/PhoneNumbers/${params.phoneNumber.providerNumberId}`,
    ).catch(() => undefined);
  }

  /**
   * Idempotent number-to-trunk attachment. Twilio answers 409 when the number is
   * already attached, which is the state this wants; every other failure is real.
   */
  private async attachNumberToTrunk(
    credentials: { accountSid: string; authToken: string },
    trunkSid: string,
    phoneNumberSid: string,
  ): Promise<void> {
    try {
      await this.trunkingRequest(credentials, 'POST', `/Trunks/${trunkSid}/PhoneNumbers`, {
        PhoneNumberSid: phoneNumberSid,
      });
    } catch (err) {
      const alreadyAttached =
        err instanceof AppError &&
        (err.details as { twilio_status?: number } | undefined)?.twilio_status === 409;
      if (!alreadyAttached) throw err;
    }
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

  /**
   * Refusal for a caller the billing gate would not admit. Deliberately says
   * nothing about the account's billing state: the caller is a third party who
   * is not entitled to know why the business cannot take the call.
   */
  buildBillingRefusalTwiml(): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say('Sorry, this number cannot take calls right now. Please try again later.');
    response.hangup();
    return response.toString();
  }

  /**
   * Creates, or reuses, the Elastic SIP Trunk that carries this account's calls.
   *
   * Twilio Programmable Voice cannot deliver a call to our media plane: TwiML
   * `<Dial><Sip>` dials a URI named up front, and LiveKit routes inbound calls by
   * the number that was called, which that URI cannot carry per call. Trunk
   * origination does carry it - Twilio puts the dialed E.164 in the request URI's
   * user part - so the trunk is what makes inbound calling work at all. It also
   * gives outbound a termination SIP domain, which is why the trunk is created
   * when the account is connected rather than per number.
   *
   * Every step looks before it creates, so re-running against a configured
   * account changes nothing.
   */
  async ensureSipTrunk(params: {
    credentials: ProviderCredentials;
    originationSipUri: string;
    existingUsername?: string | null;
  }): Promise<ProviderSipTrunk> {
    const credentials = this.assertCredentials(params.credentials);

    const trunks = await this.trunkingRequest<{ trunks?: TwilioTrunk[] }>(
      credentials,
      'GET',
      '/Trunks?PageSize=50',
    );
    let trunk = (trunks.trunks ?? []).find((item) => item.friendly_name === TRUNK_FRIENDLY_NAME);
    if (!trunk) {
      trunk = await this.trunkingRequest<TwilioTrunk>(credentials, 'POST', '/Trunks', {
        FriendlyName: TRUNK_FRIENDLY_NAME,
        // Twilio requires a globally unique termination domain, so the label is
        // random rather than derived from the account or the workspace.
        DomainName: `vf-${randomBytes(6).toString('hex')}.pstn.twilio.com`,
      });
    }

    const origination = await this.trunkingRequest<{ origination_urls?: TwilioOriginationUrl[] }>(
      credentials,
      'GET',
      `/Trunks/${trunk.sid}/OriginationUrls`,
    );
    let originationUrl = (origination.origination_urls ?? []).find(
      (item) => item.sip_url === params.originationSipUri,
    );
    if (!originationUrl) {
      originationUrl = await this.trunkingRequest<TwilioOriginationUrl>(
        credentials,
        'POST',
        `/Trunks/${trunk.sid}/OriginationUrls`,
        {
          FriendlyName: 'VoiceForge media plane',
          SipUrl: params.originationSipUri,
          Priority: '1',
          Weight: '1',
          Enabled: 'true',
        },
      );
    }

    // Termination credentials protect the trunk's SIP domain, which is a public
    // endpoint: without them anyone who learns the domain can place calls billed
    // to the customer. Twilio never returns a password, so one is minted only
    // when the caller holds none.
    let credentialListSid: string | null = null;
    let username: string | null = params.existingUsername ?? null;
    let password: string | null = null;
    if (!params.existingUsername) {
      const credentialList = await this.voiceRequest<{ sid: string }>(
        credentials,
        'POST',
        `/Accounts/${credentials.accountSid}/SIP/CredentialLists.json`,
        { FriendlyName: TRUNK_FRIENDLY_NAME },
      );
      credentialListSid = credentialList.sid;
      username = `vf_${randomBytes(4).toString('hex')}`;
      password = generateSipPassword();
      await this.voiceRequest(
        credentials,
        'POST',
        `/Accounts/${credentials.accountSid}/SIP/CredentialLists/${credentialListSid}/Credentials.json`,
        { Username: username, Password: password },
      );
      await this.trunkingRequest(credentials, 'POST', `/Trunks/${trunk.sid}/CredentialLists`, {
        CredentialListSid: credentialListSid,
      });
    }

    return {
      trunkSid: trunk.sid,
      domainName: trunk.domain_name,
      originationUrlSid: originationUrl.sid,
      credentialListSid,
      username,
      password,
    };
  }

  private async trunkingRequest<T>(
    credentials: { accountSid: string; authToken: string },
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    form?: Record<string, string>,
  ): Promise<T> {
    return this.twilioRequest<T>(credentials, method, `${TRUNKING_API}${path}`, form);
  }

  private async voiceRequest<T>(
    credentials: { accountSid: string; authToken: string },
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    form?: Record<string, string>,
  ): Promise<T> {
    return this.twilioRequest<T>(credentials, method, `${VOICE_API}${path}`, form);
  }

  /**
   * The one place a Twilio REST failure becomes an AppError.
   *
   * Twilio's own `message` is passed through: it names the exact problem ("the
   * auth token is unauthorized to create trunks", "domain already in use") and
   * the customer is the only one who can fix it in their own account.
   */
  private async twilioRequest<T>(
    credentials: { accountSid: string; authToken: string },
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    form?: Record<string, string>,
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: this.authHeader(credentials),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      const endpoint = `${method} ${stripHost(url)}`;
      throw new AppError(
        'TELEPHONY_PROVIDER_ERROR',
        body.message
          ? `Twilio rejected ${endpoint}: ${body.message}`
          : `Twilio returned HTTP ${response.status} for ${endpoint}.`,
        502,
        { twilio_status: response.status },
      );
    }
    if (method === 'DELETE') return undefined as T;
    return (await response.json()) as T;
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

interface TwilioTrunk {
  sid: string;
  friendly_name?: string;
  domain_name: string;
}

interface TwilioOriginationUrl {
  sid: string;
  sip_url?: string;
}

function stripHost(url: string): string {
  return url.replace(/^https:\/\/[^/]+/, '');
}

/**
 * A termination password Twilio accepts: at least 12 characters with an
 * upper-case letter, a lower-case letter and a digit.
 */
function generateSipPassword(): string {
  const body = randomBytes(18).toString('base64url').replace(/[^A-Za-z0-9]/g, '');
  return `Vf1${body}`.slice(0, 24);
}
