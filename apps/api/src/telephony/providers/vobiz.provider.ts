import type { ProviderCredentials } from '@voiceforge/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
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

interface VobizNumber {
  /** Documented account/partner inventory shape. */
  id?: string;
  e164?: string;
  account_id?: string;
  application_id?: string;
  capabilities?: Record<string, unknown>;
  voice_enabled?: boolean;
  trunk_group_id?: string;
  /** Legacy/alternate keys kept for backwards compatibility. */
  number?: string;
  trunk_id?: string;
  status?: string;
  application_name?: string;
  number_type?: string;
  country?: string;
  region?: string;
}

/**
 * Vobiz returns number lists under `items`, but older/alternate responses use
 * `data`. Trunks come back under `objects`. The first key present wins.
 */
const NUMBER_LIST_KEYS = ['items', 'data'] as const;
const TRUNK_LIST_KEYS = ['objects'] as const;

/**
 * Deliberately not a discriminated union: the API build tsconfig does not narrow
 * boolean-literal discriminants, so `numbers` and `failure` are both always present.
 * `failure` is null on success.
 */
interface NumberFetchOutcome {
  numbers: ProviderPhoneNumber[];
  failure: string | null;
}

interface VobizTrunk {
  trunk_id: string;
  name?: string;
  trunk_domain?: string;
  trunk_status?: string;
  trunk_direction?: string;
}

export class VobizProviderAdapter implements PhoneNumberProviderAdapter {
  readonly provider = 'vobiz' as const;
  private readonly fetchImpl: FetchLike;

  constructor(deps: { fetch?: FetchLike } = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  async validateCredentials(credentials: ProviderCredentials): Promise<ProviderValidationResult> {
    const vobizCredentials = this.assertCredentials(credentials);
    const response = await this.fetchImpl(
      `https://api.vobiz.ai/api/v1/Account/${vobizCredentials.authId}/trunks?limit=1`,
      { headers: this.headers(vobizCredentials) },
    );
    if (!response.ok) {
      return { valid: false, message: `Vobiz credentials failed with HTTP ${response.status}` };
    }
    return { valid: true, providerAccountId: vobizCredentials.customerAuthId ?? vobizCredentials.authId };
  }

  async listPhoneNumbers(credentials: ProviderCredentials): Promise<ProviderPhoneNumber[]> {
    const vobizCredentials = this.assertCredentials(credentials);
    const failures: string[] = [];

    // Partner credentials can read a specific customer's inventory. This is only
    // available to accounts with Partner API access, so it is attempted first and
    // then falls back to the account-scoped endpoint instead of failing the sync.
    if (vobizCredentials.customerAuthId && vobizCredentials.customerAuthId !== vobizCredentials.authId) {
      const partner = await this.fetchNumbers(
        `https://api.vobiz.ai/api/v1/partner/accounts/${vobizCredentials.customerAuthId}/numbers?page=1&per_page=100`,
        vobizCredentials,
      );
      if (partner.numbers.length) return partner.numbers;
      if (partner.failure) failures.push(`partner inventory (${partner.failure})`);
    }

    // Master accounts (MA_) already include sub-account numbers here, so this is
    // the correct path for both standalone and master accounts.
    const accountAuthId = vobizCredentials.customerAuthId ?? vobizCredentials.authId;
    const owned = await this.fetchNumbers(
      `https://api.vobiz.ai/api/v1/Account/${accountAuthId}/numbers?page=1&per_page=100`,
      vobizCredentials,
    );
    if (owned.numbers.length) return owned.numbers;
    if (owned.failure) failures.push(`account numbers (${owned.failure})`);

    // No DIDs are exposed to the API: fall back to trunks so trunk-only Vobiz
    // setups can still be imported with a manually supplied phone number. This
    // reads the same account as the number lookup above: with Partner
    // credentials the trunks of interest belong to the customer sub-account,
    // not to the partner account that authenticates the request.
    const trunks = await this.fetchTrunks(vobizCredentials, accountAuthId);
    if (!trunks.failure) return trunks.numbers;
    failures.push(`account trunks (${trunks.failure})`);

    throw new AppError(
      'PROVIDER_CREDENTIALS_INVALID',
      `Vobiz number sync failed. ${failures.join('; ')}`,
      400,
    );
  }

  async getPhoneNumber(credentials: ProviderCredentials, providerNumberId: string): Promise<ProviderPhoneNumber> {
    const numbers = await this.listPhoneNumbers(credentials);
    const number = numbers.find((item) => item.providerNumberId === providerNumberId);
    if (!number) {
      throw new AppError('TELEPHONY_NOT_FOUND', 'Vobiz number or trunk was not found.', 404);
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
    const credentials = this.assertCredentials(params.credentials);
    const trunkId = params.phoneNumber.sipTrunkId ?? params.phoneNumber.providerNumberId;
    if (!trunkId) {
      return {
        status: 'manual_required',
        message: 'Vobiz trunk ID is missing. Configure the LiveKit SIP destination manually.',
        manualInstructions: this.manualInstructions(params.livekitSipUri, params.statusCallbackUrl),
      };
    }
    const destination = params.livekitSipUri.replace(/^sip:/, '');
    const response = await this.fetchImpl(
      `https://api.vobiz.ai/api/v1/Account/${credentials.authId}/trunks/${trunkId}`,
      {
        method: 'PATCH',
        headers: this.headers(credentials),
        body: JSON.stringify({
          inbound_destination: destination,
          webhook_url: params.statusCallbackUrl,
          webhook_method: 'POST',
        }),
      },
    );
    if (!response.ok) {
      return {
        status: 'manual_required',
        message: `Vobiz trunk update failed with HTTP ${response.status}.`,
        manualInstructions: this.manualInstructions(params.livekitSipUri, params.statusCallbackUrl),
      };
    }
    return { status: 'configured', providerRoutingId: trunkId };
  }

  async removeRouting(_params: { credentials: ProviderCredentials; phoneNumber: ConnectedPhoneNumber }): Promise<void> {
    return undefined;
  }

  async validateWebhookSignature(params: ValidateWebhookParams): Promise<boolean> {
    if (!params.secret) return false;
    const provided = normalizeSignature(
      header(params.headers, 'x-vobiz-signature') ?? header(params.headers, 'x-signature'),
    );
    if (!provided) return false;

    const timestamp = header(params.headers, 'x-vobiz-timestamp');
    const rawBody = params.rawBody ?? JSON.stringify(params.body ?? {});
    if (timestamp) {
      if (!isRecentVobizTimestamp(timestamp)) return false;
      if (safeHexEqual(provided, hmacSha256(params.secret, `${timestamp}.${rawBody}`))) return true;
    }
    return safeHexEqual(provided, hmacSha256(params.secret, rawBody));
  }

  /**
   * Performs a Vobiz GET, converting every failure mode into a `failure` string.
   *
   * Transport rejections and malformed JSON must not throw: an exception here
   * would abort `listPhoneNumbers` before the remaining fallback sources ran,
   * which is precisely the single-point-of-failure this adapter exists to avoid.
   */
  private async requestJson(
    url: string,
    credentials: { authId: string; authToken: string },
  ): Promise<{ payload: unknown; failure: string | null }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { ...this.headers(credentials), Accept: 'application/json' },
      });
    } catch (error) {
      return { payload: null, failure: `request failed: ${describeError(error)}` };
    }
    if (!response.ok) {
      return { payload: null, failure: await this.describeFailure(response) };
    }
    try {
      return { payload: await response.json(), failure: null };
    } catch (error) {
      return { payload: null, failure: `invalid JSON response: ${describeError(error)}` };
    }
  }

  private async fetchNumbers(
    url: string,
    credentials: { authId: string; authToken: string },
  ): Promise<NumberFetchOutcome> {
    const { payload, failure } = await this.requestJson(url, credentials);
    if (failure) return { numbers: [], failure };

    const items = readArrayField<VobizNumber>(payload, NUMBER_LIST_KEYS);
    if (!items) {
      return { numbers: [], failure: 'unexpected response shape: numbers were not a list' };
    }
    return {
      numbers: items.filter(isRecord).map((number) => this.mapNumber(number)),
      failure: null,
    };
  }

  private async fetchTrunks(
    credentials: { authId: string; authToken: string },
    accountAuthId: string,
  ): Promise<NumberFetchOutcome> {
    const { payload, failure } = await this.requestJson(
      `https://api.vobiz.ai/api/v1/Account/${accountAuthId}/trunks?limit=100`,
      credentials,
    );
    if (failure) return { numbers: [], failure };

    const objects = readArrayField<VobizTrunk>(payload, TRUNK_LIST_KEYS);
    if (!objects) {
      return { numbers: [], failure: 'unexpected response shape: trunks were not a list' };
    }
    return {
      failure: null,
      // A trunk without an ID cannot be routed or re-identified on a later sync,
      // so it is dropped rather than imported as a blank entry.
      numbers: objects
        .filter((trunk): trunk is VobizTrunk => isRecord(trunk) && typeof trunk.trunk_id === 'string')
        .map((trunk) => ({
          providerNumberId: trunk.trunk_id,
          phoneNumberE164: null,
          friendlyName: trunk.name ?? trunk.trunk_id,
          capabilities: { voice: true, inbound: trunk.trunk_direction !== 'outbound', outbound: trunk.trunk_direction !== 'inbound' },
          metadata: {
            sipTrunkId: trunk.trunk_id,
            sipTrunkDomain: trunk.trunk_domain,
            status: trunk.trunk_status,
            requiresPhoneNumber: true,
          },
        })),
    };
  }

  private async describeFailure(response: Response): Promise<string> {
    const readText = (response as { text?: () => Promise<string> }).text;
    if (typeof readText !== 'function') return `HTTP ${response.status}`;
    try {
      const body = (await readText.call(response)).trim();
      return body ? `HTTP ${response.status}: ${body.slice(0, 300)}` : `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  private mapNumber(number: VobizNumber): ProviderPhoneNumber {
    const rawNumber = number.e164 ?? number.number ?? null;
    const phoneNumberE164 = toE164OrNull(rawNumber);
    const sipTrunkId = number.trunk_group_id ?? number.trunk_id ?? null;
    const voice = typeof number.capabilities?.voice === 'boolean'
      ? number.capabilities.voice
      : (number.voice_enabled ?? true);
    return {
      providerNumberId: sipTrunkId ?? rawNumber ?? number.id ?? '',
      phoneNumberE164,
      friendlyName: number.application_name ?? rawNumber ?? number.id ?? null,
      capabilities: { voice, inbound: true, outbound: true },
      metadata: {
        ...(sipTrunkId ? { sipTrunkId } : {}),
        ...(number.id ? { providerNumberUuid: number.id } : {}),
        ...(number.account_id ? { accountId: number.account_id } : {}),
        ...(number.application_id ? { applicationId: number.application_id } : {}),
        status: number.status,
        type: number.number_type,
        country: number.country,
        region: number.region,
        requiresPhoneNumber: !phoneNumberE164,
      },
    };
  }

  private manualInstructions(livekitSipUri: string, statusCallbackUrl: string): Record<string, unknown> {
    return {
      livekitSipUri,
      livekitSipHost: livekitSipUri.replace(/^sip:/, ''),
      transport: 'UDP or TCP',
      statusCallbackUrl,
    };
  }

  private assertCredentials(credentials: ProviderCredentials) {
    if (credentials.provider !== 'vobiz') {
      throw new AppError('PROVIDER_CREDENTIALS_INVALID', 'Expected Vobiz credentials.', 400);
    }
    return credentials;
  }

  private headers(credentials: { authId: string; authToken: string }): Record<string, string> {
    return {
      'X-Auth-ID': credentials.authId,
      'X-Auth-Token': credentials.authToken,
      'Content-Type': 'application/json',
    };
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function hmacSha256(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function normalizeSignature(value: string | null): string | null {
  const normalized = value?.trim().replace(/^sha256=/i, '') ?? '';
  return /^[a-f0-9]{64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function isRecentVobizTimestamp(value: string): boolean {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return false;
  const timestampMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  return Math.abs(Date.now() - timestampMs) <= 5 * 60 * 1000;
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toE164OrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\+[1-9]\d{6,14}$/.test(trimmed) ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the first key that holds an array, `[]` when the payload is a
 * well-formed envelope carrying no list, or `null` when the shape is wrong
 * enough that the caller should treat it as a failed source and fall through.
 */
function readArrayField<T>(payload: unknown, keys: readonly string[]): T[] | null {
  if (Array.isArray(payload)) return payload as T[];
  if (!isRecord(payload)) return null;
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value as T[];
    // Present but not a list: the endpoint answered in a shape we cannot read.
    if (value !== undefined && value !== null) return null;
  }
  return [];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
