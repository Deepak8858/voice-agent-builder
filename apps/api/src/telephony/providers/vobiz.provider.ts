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

interface VobizNumberListResponse {
  items?: VobizNumber[];
  data?: VobizNumber[];
}

type NumberFetchOutcome =
  | { ok: true; numbers: ProviderPhoneNumber[] }
  | { ok: false; message: string };

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
      if (partner.ok && partner.numbers.length) return partner.numbers;
      if (!partner.ok) failures.push(`partner inventory (${partner.message})`);
    }

    // Master accounts (MA_) already include sub-account numbers here, so this is
    // the correct path for both standalone and master accounts.
    const accountAuthId = vobizCredentials.customerAuthId ?? vobizCredentials.authId;
    const owned = await this.fetchNumbers(
      `https://api.vobiz.ai/api/v1/Account/${accountAuthId}/numbers?page=1&per_page=100`,
      vobizCredentials,
    );
    if (owned.ok && owned.numbers.length) return owned.numbers;
    if (!owned.ok) failures.push(`account numbers (${owned.message})`);

    // No DIDs are exposed to the API: fall back to trunks so trunk-only Vobiz
    // setups can still be imported with a manually supplied phone number.
    const trunks = await this.fetchTrunks(vobizCredentials);
    if (trunks.ok) return trunks.numbers;
    failures.push(`account trunks (${trunks.message})`);

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

  private async fetchNumbers(
    url: string,
    credentials: { authId: string; authToken: string },
  ): Promise<NumberFetchOutcome> {
    const response = await this.fetchImpl(url, {
      headers: { ...this.headers(credentials), Accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, message: await this.describeFailure(response) };
    }
    const payload = (await response.json()) as VobizNumberListResponse;
    const items = payload.items ?? payload.data ?? [];
    return { ok: true, numbers: items.map((number) => this.mapNumber(number)) };
  }

  private async fetchTrunks(credentials: { authId: string; authToken: string }): Promise<NumberFetchOutcome> {
    const response = await this.fetchImpl(
      `https://api.vobiz.ai/api/v1/Account/${credentials.authId}/trunks?limit=100`,
      { headers: this.headers(credentials) },
    );
    if (!response.ok) {
      return { ok: false, message: await this.describeFailure(response) };
    }
    const data = (await response.json()) as { objects?: VobizTrunk[] };
    return {
      ok: true,
      numbers: (data.objects ?? []).map((trunk) => ({
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
