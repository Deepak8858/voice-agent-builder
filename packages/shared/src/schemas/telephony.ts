import { z } from 'zod';
import { OutboundComplianceSchema } from './compliance';

const E164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be E.164, for example +14155551234');

export const PhoneProviderSchema = z.enum(['twilio', 'vobiz']);
export type PhoneProvider = z.infer<typeof PhoneProviderSchema>;

// Superset of PhoneProviderSchema for phone-number rows: 'sip' rows are
// generic BYO trunks with no provider connection, credentials, or adapter.
export const PhoneNumberProviderSchema = z.enum(['twilio', 'vobiz', 'sip']);
export type PhoneNumberProvider = z.infer<typeof PhoneNumberProviderSchema>;

export const TelephonyConnectionStatusSchema = z.enum([
  'connected',
  'invalid',
  'error',
  'disconnected',
]);
export type TelephonyConnectionStatus = z.infer<typeof TelephonyConnectionStatusSchema>;

export const TelephonyPhoneNumberStatusSchema = z.enum([
  'pending_verification',
  'verified',
  'livekit_configured',
  'active',
  'error',
  'disconnected',
]);
export type TelephonyPhoneNumberStatus = z.infer<typeof TelephonyPhoneNumberStatusSchema>;

export const TwilioConnectionCredentialsSchema = z.object({
  provider: z.literal('twilio'),
  accountSid: z.string().min(2),
  authToken: z.string().min(8),
});
export type TwilioConnectionCredentials = z.infer<typeof TwilioConnectionCredentialsSchema>;

export const VobizConnectionCredentialsSchema = z.object({
  provider: z.literal('vobiz'),
  authId: z.string().min(2),
  authToken: z.string().min(8),
  customerAuthId: z.string().min(2).optional(),
});
export type VobizConnectionCredentials = z.infer<typeof VobizConnectionCredentialsSchema>;

export const ProviderCredentialsSchema = z.discriminatedUnion('provider', [
  TwilioConnectionCredentialsSchema,
  VobizConnectionCredentialsSchema,
]);
export type ProviderCredentials = z.infer<typeof ProviderCredentialsSchema>;

export const CreateTelephonyConnectionDtoSchema = z
  .object({
    provider: PhoneProviderSchema,
    display_name: z.string().trim().min(1).max(120),
    credentials: ProviderCredentialsSchema,
  })
  .strict();
export type CreateTelephonyConnectionDto = z.infer<typeof CreateTelephonyConnectionDtoSchema>;

export const SyncedProviderPhoneNumberSchema = z
  .object({
    provider_number_id: z.string().trim().min(1),
    phone_number: E164PhoneSchema.nullable(),
    friendly_name: z.string().trim().max(120).nullable().optional(),
    requires_phone_number: z.boolean().default(false),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SyncedProviderPhoneNumber = z.infer<typeof SyncedProviderPhoneNumberSchema>;

export const ImportProviderPhoneNumberSchema = z
  .object({
    provider_number_id: z.string().trim().min(1),
    phone_number: E164PhoneSchema,
    friendly_name: z.string().trim().max(120).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    webhook_secret: z.string().trim().min(8).max(255).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ImportPhoneNumbersDtoSchema = z
  .object({
    connection_id: z.string().uuid(),
    numbers: z.array(ImportProviderPhoneNumberSchema).min(1).max(50),
  })
  .strict();
export type ImportPhoneNumbersDto = z.infer<typeof ImportPhoneNumbersDtoSchema>;

export const ManualPhoneNumberDtoSchema = z
  .object({
    provider: PhoneProviderSchema,
    phone_number: E164PhoneSchema,
    friendly_name: z.string().trim().max(120).optional(),
    provider_account_id: z.string().trim().max(120).optional(),
    provider_number_id: z.string().trim().max(160).optional(),
    sip_trunk_id: z.string().trim().max(160).optional(),
    sip_trunk_domain: z.string().trim().max(255).optional(),
    webhook_secret: z.string().trim().max(255).optional(),
    inbound_enabled: z.boolean().default(true),
    outbound_enabled: z.boolean().default(false),
  })
  .strict();
export type ManualPhoneNumberDto = z.infer<typeof ManualPhoneNumberDtoSchema>;

export const SipTrunkNumberDtoSchema = z
  .object({
    phone_number: E164PhoneSchema,
    sip_trunk_domain: z.string().trim().min(1).max(255),
    sip_auth_username: z.string().trim().min(1).max(120).optional(),
    sip_auth_password: z.string().min(1).max(255).optional(),
  })
  .strict();
export type SipTrunkNumberDto = z.infer<typeof SipTrunkNumberDtoSchema>;

export const AssignPhoneNumberAgentDtoSchema = z
  .object({
    agent_id: z.string().uuid().nullable(),
    inbound_enabled: z.boolean().optional(),
    outbound_enabled: z.boolean().optional(),
  })
  .strict();
export type AssignPhoneNumberAgentDto = z.infer<typeof AssignPhoneNumberAgentDtoSchema>;

export const StartTelephonyOutboundCallDtoSchema = z
  .object({
    phone_number_id: z.string().uuid(),
    to_number: E164PhoneSchema,
    contact_name: z.string().max(120).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** Consent attestation / call window for this one dial; see OutboundComplianceSchema. */
    compliance: OutboundComplianceSchema.optional(),
  })
  .strict();
export type StartTelephonyOutboundCallDto = z.infer<typeof StartTelephonyOutboundCallDtoSchema>;

/**
 * Inbound admission asked for by the voice runtime.
 *
 * Only the Twilio TwiML webhook could admit an inbound call, so a call handed
 * straight to LiveKit over SIP (a BYO trunk, Vobiz, or a Twilio number moved
 * onto an Elastic SIP trunk) reached the agent with no admitted call row and
 * was dropped. The runtime asks for admission over this contract instead, so
 * one admission path serves every provider. camelCase like the other runtime
 * contracts (see RuntimeUsageEventSchema); tenant DTOs stay snake_case.
 */
export const InboundCallAdmitRequestSchema = z
  .object({
    organizationId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    phoneNumberId: z.string().uuid(),
    agentId: z.string().uuid(),
    provider: PhoneNumberProviderSchema,
    providerCallId: z.string().min(1).max(200),
    fromNumber: z.string().min(1).max(32).nullish(),
    toNumber: z.string().min(1).max(32).nullish(),
    roomName: z.string().min(1).max(200).nullish(),
    participantIdentity: z.string().min(1).max(200).nullish(),
  })
  .strict();
export type InboundCallAdmitRequest = z.infer<typeof InboundCallAdmitRequestSchema>;

export const InboundCallAdmitResponseSchema = z
  .object({
    admitted: z.boolean(),
    callId: z.string().uuid().nullable(),
    reason: z.string().min(1).nullable(),
  })
  .strict();
export type InboundCallAdmitResponse = z.infer<typeof InboundCallAdmitResponseSchema>;

/**
 * Runtime -> API request to dial the agent's configured human into the live
 * call. The target number is deliberately absent: the internal key is one
 * credential for every tenant, so the API reads the target from the agent's
 * own spec instead of dialling whatever the request names.
 */
export const HandoffDialRequestSchema = z
  .object({
    callId: z.string().uuid(),
    agentId: z.string().uuid(),
    summary: z.string().max(1000).nullish(),
  })
  .strict();
export type HandoffDialRequest = z.infer<typeof HandoffDialRequestSchema>;

export const HandoffDialResponseSchema = z
  .object({
    connected: z.boolean(),
    participantIdentity: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type HandoffDialResponse = z.infer<typeof HandoffDialResponseSchema>;
