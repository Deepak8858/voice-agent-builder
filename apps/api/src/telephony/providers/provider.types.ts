import type { PhoneProvider, ProviderCredentials } from '@voiceforge/shared';

export interface ProviderValidationResult {
  valid: boolean;
  providerAccountId?: string | null;
  message?: string;
}

export interface ProviderPhoneNumber {
  providerNumberId: string;
  phoneNumberE164: string | null;
  friendlyName?: string | null;
  capabilities: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ConnectedPhoneNumber {
  id: string;
  provider: PhoneProvider;
  providerNumberId?: string | null;
  phoneNumberE164: string;
  sipTrunkId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * A carrier-side SIP trunk that carries calls between the provider's account and
 * our media plane, created in the customer's own provider account.
 *
 * `password` is only present on the call that created the credential: providers
 * do not read passwords back, so it must be persisted by the caller.
 */
export interface ProviderSipTrunk {
  trunkSid: string;
  domainName: string;
  originationUrlSid?: string | null;
  credentialListSid?: string | null;
  username?: string | null;
  password?: string | null;
}

export interface ProviderRoutingResult {
  status: 'configured' | 'manual_required';
  providerRoutingId?: string | null;
  message?: string;
  manualInstructions?: Record<string, unknown>;
}

export interface ValidateWebhookParams {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  rawBody?: string;
  secret?: string | null;
}

export interface NormalizedInboundCall {
  providerCallId: string;
  fromNumber?: string | null;
  toNumber?: string | null;
  eventId?: string | null;
}

export interface NormalizedCallStatus {
  providerCallId: string;
  status: string;
  eventId?: string | null;
}

export interface PhoneNumberProviderAdapter {
  provider: PhoneProvider;
  validateCredentials(credentials: ProviderCredentials): Promise<ProviderValidationResult>;
  listPhoneNumbers(credentials: ProviderCredentials): Promise<ProviderPhoneNumber[]>;
  getPhoneNumber(credentials: ProviderCredentials, providerNumberId: string): Promise<ProviderPhoneNumber>;
  /**
   * Creates (or reuses) the provider-side SIP trunk pointed at our media plane.
   *
   * Optional because only providers with a trunk-provisioning API can do it;
   * the rest need the customer to configure their carrier by hand.
   */
  ensureSipTrunk?(params: {
    credentials: ProviderCredentials;
    /** Where the provider should send inbound INVITEs, e.g. `sip:host;transport=tcp`. */
    originationSipUri: string;
    /** Existing digest username, so a re-run does not mint a second credential. */
    existingUsername?: string | null;
    /**
     * Trunk a previous run provisioned. Reused by SID so a re-run cannot pick up
     * a different trunk that happens to share our name.
     */
    existingTrunkSid?: string | null;
  }): Promise<ProviderSipTrunk>;
  configureInboundRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    livekitSipUri: string;
    fallbackWebhookUrl: string;
    statusCallbackUrl: string;
    /** Attach the number to this provider-side trunk instead of a webhook. */
    trunkSid?: string | null;
  }): Promise<ProviderRoutingResult>;
  configureOutboundRouting?(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    livekitOutboundTrunkId: string;
  }): Promise<ProviderRoutingResult>;
  removeRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    trunkSid?: string | null;
  }): Promise<void>;
  validateWebhookSignature?(params: ValidateWebhookParams): Promise<boolean>;
  normalizeInboundPayload?(payload: unknown): NormalizedInboundCall;
  normalizeStatusPayload?(payload: unknown): NormalizedCallStatus;
}
