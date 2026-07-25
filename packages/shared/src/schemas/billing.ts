import { z } from 'zod';
import { PLAN_LIMITS } from '../billing/catalog';

export { PLAN_LIMITS } from '../billing/catalog';

// --------------------------------------------------------------------------
// Enums
// --------------------------------------------------------------------------

export const PlanTypeSchema = z.enum(['free', 'starter', 'growth', 'enterprise']);
export type PlanType = z.infer<typeof PlanTypeSchema>;

export const CheckoutPlanSchema = z.enum(['starter', 'growth']);
export type CheckoutPlan = z.infer<typeof CheckoutPlanSchema>;

export const SubscriptionStatusSchema = z.enum([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const UsageTypeSchema = z.enum(['calls', 'minutes', 'tools', 'agents']);
export type UsageType = z.infer<typeof UsageTypeSchema>;

export type PlanLimits = typeof PLAN_LIMITS;

export const RelativeBillingPathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (!value.startsWith('/') || value.startsWith('//')) return false;
    if (value.includes('\\') || /[\u0000-\u001f]/.test(value)) return false;
    try {
      const parsed = new URL(value, 'https://app.voiceforge.local');
      return parsed.origin === 'https://app.voiceforge.local';
    } catch {
      return false;
    }
  }, 'Must be a safe relative path');

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

export const CreateCheckoutSessionDtoSchema = z
  .object({
    plan: CheckoutPlanSchema,
    successPath: RelativeBillingPathSchema.default('/checkout/success'),
    cancelPath: RelativeBillingPathSchema.default('/checkout/cancel'),
  })
  .strict();
export type CreateCheckoutSessionDto = z.infer<typeof CreateCheckoutSessionDtoSchema>;

export const CreateTopUpCheckoutDtoSchema = z
  .object({
    successPath: RelativeBillingPathSchema.default('/dashboard/billing?topup=success'),
    cancelPath: RelativeBillingPathSchema.default('/dashboard/billing?topup=cancel'),
  })
  .strict();
export type CreateTopUpCheckoutDto = z.infer<typeof CreateTopUpCheckoutDtoSchema>;

export const CreatePortalSessionDtoSchema = z
  .object({
    returnPath: RelativeBillingPathSchema.default('/dashboard/billing'),
  })
  .strict();
export type CreatePortalSessionDto = z.infer<typeof CreatePortalSessionDtoSchema>;

/** Compatibility response shape for existing billing-status consumers. */
export interface BillingStatusDto {
  mode: 'demo' | 'live';
  liveCheckoutEnabled: boolean;
  message: string;
}

export const SubscriptionDtoSchema = z.object({
  id: z.string().uuid(),
  plan: PlanTypeSchema,
  status: SubscriptionStatusSchema,
  currentPeriodStart: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  trialEnd: z.string().datetime().nullable(),
  stripeCustomerId: z.string().nullable(),
});
export type SubscriptionDto = z.infer<typeof SubscriptionDtoSchema>;

export const UsageRecordDtoSchema = z.object({
  id: z.string().uuid(),
  billableMetric: UsageTypeSchema,
  quantity: z.number().int(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  recordedAt: z.string().datetime(),
});
export type UsageRecordDto = z.infer<typeof UsageRecordDtoSchema>;

export const WorkspaceUsageDtoSchema = z.object({
  workspaceId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  metrics: z.record(UsageTypeSchema, z.number().int()),
  limits: z.record(UsageTypeSchema, z.number().int()),
  usage: z.record(UsageTypeSchema, z.number().int()),
});
export type WorkspaceUsageDto = z.infer<typeof WorkspaceUsageDtoSchema>;

export const EntitlementReasonSchema = z.enum([
  'allowed',
  'subscription_required',
  'subscription_inactive',
  'trial_already_used',
  'credit_insufficient',
  'agent_limit_reached',
  'workspace_limit_reached',
  'integration_limit_reached',
  'organization_concurrency_reached',
  'platform_concurrency_reached',
  'billing_temporarily_unavailable',
]);
export type EntitlementReason = z.infer<typeof EntitlementReasonSchema>;

const IdentifierSchema = z.string().trim().min(1);

export const EntitlementDecisionSchema = z
  .object({
    organizationId: IdentifierSchema,
    plan: PlanTypeSchema,
    allowed: z.boolean(),
    reason: EntitlementReasonSchema,
  })
  .strict();
export type EntitlementDecision = z.infer<typeof EntitlementDecisionSchema>;

export const CreditBalanceDtoSchema = z
  .object({
    organizationId: IdentifierSchema,
    includedMinutesRemaining: z.number().int().nonnegative(),
    purchasedMinutesRemaining: z.number().int().nonnegative(),
    lifetimeBrowserTestSecondsRemaining: z.number().int().nonnegative(),
  })
  .strict();
export type CreditBalanceDto = z.infer<typeof CreditBalanceDtoSchema>;

const RuntimeUsageEventBaseSchema = {
  eventId: IdentifierSchema,
  callId: IdentifierSchema,
  organizationId: IdentifierSchema,
  occurredAt: z.string().datetime(),
};

export const RuntimeUsageEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...RuntimeUsageEventBaseSchema,
    type: z.literal('call_connected'),
    providerCallId: IdentifierSchema,
  }).strict(),
  z.object({
    ...RuntimeUsageEventBaseSchema,
    type: z.literal('minute_boundary'),
    minute: z.number().int().positive(),
  }).strict(),
  z.object({
    ...RuntimeUsageEventBaseSchema,
    type: z.literal('call_ended'),
    durationSeconds: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ...RuntimeUsageEventBaseSchema,
    type: z.literal('call_failed'),
    failureCode: IdentifierSchema,
  }).strict(),
]);
export type RuntimeUsageEvent = z.infer<typeof RuntimeUsageEventSchema>;

export const RuntimeUsageDecisionSchema = z
  .object({
    eventId: IdentifierSchema,
    callId: IdentifierSchema,
    organizationId: IdentifierSchema,
    allowed: z.boolean(),
    reason: EntitlementReasonSchema,
    billableMinutes: z.number().int().nonnegative(),
    creditBalance: CreditBalanceDtoSchema,
  })
  .strict();
export type RuntimeUsageDecision = z.infer<typeof RuntimeUsageDecisionSchema>;

export const StripeEventDtoSchema = z.object({
  id: z.string().uuid(),
  stripeEventId: z.string(),
  type: z.string(),
  apiVersion: z.string().nullable(),
  created: z.string().datetime(),
  livemode: z.boolean(),
  pendingWebhooks: z.number().int(),
  processedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
});
export type StripeEventDto = z.infer<typeof StripeEventDtoSchema>;

export const InvoiceDtoSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string().nullable(),
  amountDue: z.number().int(),
  amountPaid: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  periodStart: z.number().int(),
  periodEnd: z.number().int(),
  invoicePdf: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
});
export type InvoiceDto = z.infer<typeof InvoiceDtoSchema>;

// --------------------------------------------------------------------------
// Feature gate
// --------------------------------------------------------------------------

export const FeatureGateSchema = z.enum([
  'outbound',
  'ai_insights',
  'compliance_blocks',
  'white_label',
  'api_access',
  'bulk_import',
  'analytics',
  'multiple_workspaces',
  'tools',
  'byo_telephony',
]);
export type FeatureGate = z.infer<typeof FeatureGateSchema>;
