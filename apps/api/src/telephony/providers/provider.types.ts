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
  configureInboundRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    livekitSipUri: string;
    fallbackWebhookUrl: string;
    statusCallbackUrl: string;
  }): Promise<ProviderRoutingResult>;
  configureOutboundRouting?(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    livekitOutboundTrunkId: string;
  }): Promise<ProviderRoutingResult>;
  removeRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
  }): Promise<void>;
  validateWebhookSignature?(params: ValidateWebhookParams): Promise<boolean>;
  normalizeInboundPayload?(payload: unknown): NormalizedInboundCall;
  normalizeStatusPayload?(payload: unknown): NormalizedCallStatus;
}
