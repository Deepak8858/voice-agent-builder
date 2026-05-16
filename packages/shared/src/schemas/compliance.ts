import { z } from 'zod';

/**
 * Compliance domain schemas. Mirrors docs/11_COMPLIANCE_ENGINE.md and the
 * `contacts`, `consent_records`, `dnc_entries`, `compliance_checks` tables in
 * docs/06_DATABASE_SCHEMA.md.
 */

// --- enums --------------------------------------------------------------

export const ConsentTypeSchema = z.enum([
  'outbound_marketing',
  'outbound_transactional',
  'recording',
  'ai_disclosure',
]);
export type ConsentType = z.infer<typeof ConsentTypeSchema>;

export const ConsentSourceSchema = z.enum([
  'web_form',
  'imported',
  'verbal',
  'api',
  'other',
]);
export type ConsentSource = z.infer<typeof ConsentSourceSchema>;

export const DncSourceSchema = z.enum(['manual', 'imported', 'request', 'regulator']);
export type DncSource = z.infer<typeof DncSourceSchema>;

export const ComplianceDirectionSchema = z.enum(['inbound', 'outbound', 'browser_test']);
export type ComplianceDirection = z.infer<typeof ComplianceDirectionSchema>;

export const ComplianceStatusSchema = z.enum(['passed', 'blocked']);
export type ComplianceStatus = z.infer<typeof ComplianceStatusSchema>;

export const ComplianceReasonCodeSchema = z.enum([
  'agent_not_published',
  'missing_consent',
  'opted_out',
  'dnc_listed',
  'outside_call_window',
  'unsupported_purpose',
  'missing_ai_disclosure',
  'missing_recording_notice',
  'recording_notice_enabled',
  'invalid_phone',
]);
export type ComplianceReasonCode = z.infer<typeof ComplianceReasonCodeSchema>;

export const ComplianceReasonSeveritySchema = z.enum(['blocking', 'warning']);
export type ComplianceReasonSeverity = z.infer<typeof ComplianceReasonSeveritySchema>;

export const ComplianceReasonSchema = z.object({
  code: ComplianceReasonCodeSchema,
  message: z.string(),
  severity: ComplianceReasonSeveritySchema.default('blocking'),
});
export type ComplianceReason = z.infer<typeof ComplianceReasonSchema>;

// --- Contact -----------------------------------------------------------

const phone = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[+0-9 ()\-.]+$/, 'phone must look like a phone number');

export const CreateContactDtoSchema = z.object({
  phone,
  email: z.string().email().optional(),
  full_name: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type CreateContactDto = z.infer<typeof CreateContactDtoSchema>;

export const UpdateContactDtoSchema = z.object({
  email: z.string().email().nullable().optional(),
  full_name: z.string().min(1).max(200).nullable().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type UpdateContactDto = z.infer<typeof UpdateContactDtoSchema>;

export const OptOutContactDtoSchema = z.object({
  reason: z.string().min(1).max(200).optional(),
});
export type OptOutContactDto = z.infer<typeof OptOutContactDtoSchema>;

export const ContactSummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  phone: z.string(),
  email: z.string().nullable(),
  full_name: z.string().nullable(),
  opt_out: z.boolean(),
  opt_out_at: z.string().nullable(),
  consent_count: z.number().int().min(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ContactSummary = z.infer<typeof ContactSummarySchema>;

export const ContactConsentSchema = z.object({
  id: z.string().uuid(),
  consent_type: ConsentTypeSchema,
  source: ConsentSourceSchema,
  proof_url: z.string().nullable(),
  consented_at: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type ContactConsent = z.infer<typeof ContactConsentSchema>;

export const ContactDetailSchema = ContactSummarySchema.extend({
  metadata: z.record(z.string(), z.any()).nullable(),
  opt_out_reason: z.string().nullable(),
  consents: z.array(ContactConsentSchema),
});
export type ContactDetail = z.infer<typeof ContactDetailSchema>;

// --- Consent -----------------------------------------------------------

export const GrantConsentDtoSchema = z.object({
  consent_type: ConsentTypeSchema,
  source: ConsentSourceSchema.default('api'),
  proof_url: z.string().url().optional(),
  expires_at: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type GrantConsentDto = z.infer<typeof GrantConsentDtoSchema>;

export const RevokeConsentDtoSchema = z.object({
  consent_type: ConsentTypeSchema,
  reason: z.string().min(1).max(200).optional(),
});
export type RevokeConsentDto = z.infer<typeof RevokeConsentDtoSchema>;

// --- DNC ---------------------------------------------------------------

export const AddDncDtoSchema = z.object({
  phone,
  source: DncSourceSchema.default('manual'),
  reason: z.string().min(1).max(200).optional(),
});
export type AddDncDto = z.infer<typeof AddDncDtoSchema>;

export const DncEntrySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  phone: z.string(),
  source: DncSourceSchema,
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type DncEntry = z.infer<typeof DncEntrySchema>;

// --- Compliance check --------------------------------------------------

export const ComplianceCheckRequestDtoSchema = z.object({
  agent_id: z.string().uuid(),
  direction: ComplianceDirectionSchema.default('outbound'),
  to_number: phone.optional(),
  contact_id: z.string().uuid().optional(),
  purpose: z.string().min(1).max(64).optional(),
});
export type ComplianceCheckRequestDto = z.infer<typeof ComplianceCheckRequestDtoSchema>;

export const ComplianceCheckResultSchema = z.object({
  id: z.string().uuid(),
  status: ComplianceStatusSchema,
  reasons: z.array(ComplianceReasonSchema),
  agent_id: z.string().uuid(),
  contact_id: z.string().uuid().nullable(),
  call_id: z.string().uuid().nullable(),
  direction: ComplianceDirectionSchema,
  checked_at: z.string(),
});
export type ComplianceCheckResult = z.infer<typeof ComplianceCheckResultSchema>;

// MVP outbound purposes from docs/11_COMPLIANCE_ENGINE.md.
export const ALLOWED_OUTBOUND_PURPOSES = [
  'appointment_reminder',
  'missed_call_callback',
  'lead_form_callback',
  'order_confirmation',
  'event_confirmation',
  'requested_follow_up',
] as const;
export type AllowedOutboundPurpose = (typeof ALLOWED_OUTBOUND_PURPOSES)[number];

export const BLOCKED_OUTBOUND_PURPOSES = [
  'cold_sales',
  'political',
  'debt_collection',
  'healthcare_diagnosis',
  'financial_advice',
  'legal_advice',
] as const;
export type BlockedOutboundPurpose = (typeof BLOCKED_OUTBOUND_PURPOSES)[number];
