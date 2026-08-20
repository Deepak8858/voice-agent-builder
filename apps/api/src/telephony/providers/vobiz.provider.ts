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

/**
 * Vobiz returns number lists under `items`, but older/alternate responses use
 * `data`. Trunks come back under `objects`. The first key present wins.
 *
 * Entries are intentionally read as `Record<string, unknown>` and narrowed field
 * by field rather than cast to an interface: the upstream shape varies between
 * documented and legacy keys, and a cast would only assert types the response
 * has not been checked to have.
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

    const items = readArrayField(payload, NUMBER_LIST_KEYS);
    if (!items) {
      return { numbers: [], failure: 'unexpected response shape: numbers were not a list' };
    }
    // Entries are mapped defensively rather than trusted: a single entry with an
    // unexpected field type must not throw, because that would abort the
    // remaining fallback sources in `listPhoneNumbers`.
    return {
      numbers: items.filter(isRecord).map((number) => this.mapNumber(number)).filter(hasProviderId),
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

    const objects = readArrayField(payload, TRUNK_LIST_KEYS);
    if (!objects) {
      return { numbers: [], failure: 'unexpected response shape: trunks were not a list' };
    }
    return {
      failure: null,
      numbers: objects.filter(isRecord).flatMap((raw) => {
        // A trunk with no usable ID cannot be routed or re-identified on a later
        // sync, so it is dropped rather than imported as a blank entry.
        const trunkId = readString(raw.trunk_id);
        if (!trunkId) return [];
        const direction = readString(raw.trunk_direction);
        return [
          {
            providerNumberId: trunkId,
            phoneNumberE164: null,
            friendlyName: readString(raw.name) ?? trunkId,
            capabilities: {
              voice: true,
              inbound: direction !== 'outbound',
              outbound: direction !== 'inbound',
            },
            metadata: {
              sipTrunkId: trunkId,
              sipTrunkDomain: readString(raw.trunk_domain),
              status: readString(raw.trunk_status),
              requiresPhoneNumber: true,
            },
          },
        ];
      }),
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

  /**
   * Maps one entry from an unvalidated Vobiz payload. Every field is read
   * through a type guard: Vobiz has returned both documented and legacy key
   * shapes, and an unexpected type on a single entry must not throw, since that
   * would abort the caller's remaining fallback sources.
   */
  private mapNumber(number: Record<string, unknown>): ProviderPhoneNumber {
    const rawNumber = readString(number.e164) ?? readString(number.number);
    const phoneNumberE164 = toE164OrNull(rawNumber);
    const sipTrunkId = readString(number.trunk_group_id) ?? readString(number.trunk_id);
    const id = readString(number.id);
    const accountId = readString(number.account_id);
    const applicationId = readString(number.application_id);
    const capabilities = isRecord(number.capabilities) ? number.capabilities : undefined;
    const voice = typeof capabilities?.voice === 'boolean'
      ? capabilities.voice
      : (typeof number.voice_enabled === 'boolean' ? number.voice_enabled : true);
    return {
      providerNumberId: sipTrunkId ?? rawNumber ?? id ?? '',
      phoneNumberE164,
      friendlyName: readString(number.application_name) ?? rawNumber ?? id ?? null,
      capabilities: { voice, inbound: true, outbound: true },
      metadata: {
        ...(sipTrunkId ? { sipTrunkId } : {}),
        ...(id ? { providerNumberUuid: id } : {}),
        ...(accountId ? { accountId } : {}),
        ...(applicationId ? { applicationId } : {}),
        status: readString(number.status),
        type: readString(number.number_type),
        country: readString(number.country),
        region: readString(number.region),
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
 * Extracts the list from a Vobiz response envelope.
 *
 * Returns the array under the first supported key that is present, or `null`
 * when no supported key exists or a present key does not hold an array. A
 * response carrying none of the expected keys is a shape we cannot read, not an
 * empty inventory, so it is reported as a failed source rather than silently
 * treated as "this account has nothing".
 */
function readArrayField(payload: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const key of keys) {
    if (!(key in payload)) continue;
    const value = payload[key];
    return Array.isArray(value) ? value : null;
  }
  return null;
}

/** Reads a string field, ignoring empty strings and every non-string type. */
function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Drops entries that carry no identifier. Such a record cannot be routed or
 * matched against on a later sync, so importing it would create an unusable row.
 */
function hasProviderId(number: ProviderPhoneNumber): boolean {
  return number.providerNumberId.length > 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
