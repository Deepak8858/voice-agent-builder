import { z } from 'zod';

const E164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be E.164, for example +14155551234');

export const PhoneProviderSchema = z.enum(['twilio', 'vobiz']);
export type PhoneProvider = z.infer<typeof PhoneProviderSchema>;

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
  })
  .strict();
export type StartTelephonyOutboundCallDto = z.infer<typeof StartTelephonyOutboundCallDtoSchema>;
