import { z } from 'zod';
import { PLAN_LIMITS } from '../billing/catalog';
import type { PlanEntitlements } from '../billing/catalog';

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

/**
 * Statuses in which Stripe still holds a live subscription object. Starting a
 * second subscription Checkout in any of these creates a *second* Stripe
 * subscription and bills the customer twice, while only one id can be stored
 * locally — the other is orphaned and never cancelled. `canceled`,
 * `incomplete` and `incomplete_expired` have nothing live to collide with, so a
 * fresh Checkout there is the normal recovery path.
 *
 * Shared because the API refuses such a Checkout and the billing panel must
 * hide the button that would attempt one. Two copies of this set drifting is
 * how a paying customer gets a 400 from a button we rendered for them.
 */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
]);

export function hasLiveSubscription(status: string): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.has(status);
}

export const UsageTypeSchema = z.enum(['calls', 'minutes', 'tools', 'agents']);
export type UsageType = z.infer<typeof UsageTypeSchema>;

/**
 * Which runtime serves a call.
 *
 * - `realtime`: speech-to-speech model (highest quality, highest cost per minute).
 * - `standard`: the in-house streaming STT -> LLM -> TTS pipeline (low latency,
 *   roughly an order of magnitude cheaper per minute).
 *
 * This is a commercial *and* operational fact about a call, so it is persisted
 * on the call row and carried in runtime dispatch metadata rather than being
 * re-derived after the fact.
 */
export const VoicePipelineSchema = z.enum(['realtime', 'standard']);
export type VoicePipeline = z.infer<typeof VoicePipelineSchema>;

/**
 * Lifecycle of an organization's credit balance. `blocked` and `review` both
 * stop paid usage; they are distinguished so support can tell an automated
 * hold from a human-driven investigation.
 */
export const CreditBalanceStatusSchema = z.enum(['active', 'blocked', 'review']);
export type CreditBalanceStatus = z.infer<typeof CreditBalanceStatusSchema>;

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

const CheckoutAttemptIdSchema = z.string().uuid();

export const CreateCheckoutSessionDtoSchema = z
  .object({
    plan: CheckoutPlanSchema,
    idempotencyKey: CheckoutAttemptIdSchema,
    successPath: RelativeBillingPathSchema.default('/checkout/success'),
    cancelPath: RelativeBillingPathSchema.default('/checkout/cancel'),
  })
  .strict();
export type CreateCheckoutSessionDto = z.infer<typeof CreateCheckoutSessionDtoSchema>;

export const CreateTopUpCheckoutDtoSchema = z
  .object({
    idempotencyKey: CheckoutAttemptIdSchema,
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

/**
 * Runtime availability of Stripe Checkout and the Customer Portal. There is no
 * "demo" billing mode: an action is either fully configured with the
 * server-owned prices it needs or it is temporarily unavailable. Missing
 * configuration never grants a recurring free allowance.
 *
 * Reported per entry point, because they fail independently: a deployment
 * missing only the minute-pack price cannot sell packs while subscription
 * checkout and the portal keep working. The client must gate each button on its
 * own flag — a single global flag hid three different outages behind one word.
 */
export const BillingStatusDtoSchema = z
  .object({
    /** Subscription Checkout — plan upgrades. */
    liveCheckoutEnabled: z.boolean(),
    /** One-time minute-pack Checkout. */
    topUpEnabled: z.boolean(),
    /** Stripe Customer Portal — payment method, invoices, cancellation. */
    portalEnabled: z.boolean(),
    message: z.string().min(1),
  })
  .strict();
export type BillingStatusDto = z.infer<typeof BillingStatusDtoSchema>;

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
  'credit_insufficient',
  'agent_limit_reached',
  'workspace_limit_reached',
  'integration_limit_reached',
  'organization_concurrency_reached',
  'platform_concurrency_reached',
  'billing_temporarily_unavailable',
  /**
   * The requested runtime pipeline is not sold on this plan. Distinct from
   * `subscription_required` because the remedy is different: the customer is
   * entitled to call, just not on that runtime.
   */
  'pipeline_not_entitled',
]);
export type EntitlementReason = z.infer<typeof EntitlementReasonSchema>;

const IdentifierSchema = z.string().trim().min(1);

/**
 * Every entitlement decision carries the numbers the caller needs to explain
 * itself to a customer: what they are using now, what their plan allows, which
 * catalog version produced the limit, and a correlation ID that ties the
 * decision to its audit record.
 */
export const EntitlementDecisionSchema = z
  .object({
    organizationId: IdentifierSchema,
    plan: PlanTypeSchema,
    allowed: z.boolean(),
    reason: EntitlementReasonSchema,
    current: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    catalogVersion: IdentifierSchema,
    correlationId: IdentifierSchema,
  })
  .strict();
export type EntitlementDecision = z.infer<typeof EntitlementDecisionSchema>;

/**
 * Subscription status resolved for an organization. `none` means the
 * organization never subscribed; `unknown` means the stored status is outside
 * the Stripe contract, which is corruption rather than absence and must not be
 * reported to the customer as "subscribe to continue".
 */
export const EffectiveSubscriptionStatusSchema = z.union([
  SubscriptionStatusSchema,
  z.literal('none'),
  z.literal('unknown'),
]);
export type EffectiveSubscriptionStatus = z.infer<typeof EffectiveSubscriptionStatusSchema>;

/**
 * The single resolved commercial position of an organization. `paidAccess` is
 * true only for `active` and an unexpired `trialing` subscription; every other
 * Stripe state blocks paid usage.
 */
export interface EffectivePlan {
  organizationId: string;
  plan: PlanType;
  status: EffectiveSubscriptionStatus;
  catalogVersion: string;
  entitlements: PlanEntitlements;
  paidAccess: boolean;
  /**
   * A paid subscription that would otherwise fund usage, whose billing period
   * ended and was never renewed. `status` stays `active` and `plan` is already
   * downgraded to free in that case, so without this flag a missed renewal
   * webhook is indistinguishable from "never subscribed" — and the customer is
   * told to subscribe when what they need is a payment fix.
   */
  periodExpired?: boolean;
}

export const PAID_CALL_MINIMUM_SECONDS = 60 as const;

export type EntitlementRequest =
  | {
      kind: 'paid_call';
      minimumSeconds: typeof PAID_CALL_MINIMUM_SECONDS;
      /**
       * Runtime the call will use. Supplied so admission can refuse a pipeline
       * the plan does not sell before any credit is reserved.
       */
      pipeline?: VoicePipeline;
    }
  /**
   * A browser test is metered exactly like a telephony minute and is funded by
   * the same balance, so it carries the same minimum. It is a distinct kind
   * only because it is the one metered call a plan without PSTN may start.
   */
  | { kind: 'browser_test'; minimumSeconds: typeof PAID_CALL_MINIMUM_SECONDS }
  | { kind: 'agent_create'; current: number }
  | { kind: 'workspace_create'; current: number }
  | { kind: 'integration_connect'; current: number }
  | { kind: 'white_label' }
  | { kind: 'campaign_launch' };

export const CreditBalanceDtoSchema = z
  .object({
    organizationId: IdentifierSchema,
    includedMinutesRemaining: z.number().int().nonnegative(),
    purchasedMinutesRemaining: z.number().int().nonnegative(),
  })
  .strict();
export type CreditBalanceDto = z.infer<typeof CreditBalanceDtoSchema>;

/**
 * Organization-wide billing state for the dashboard. Seconds are reported
 * separately by source so a customer can see what expires at the period end,
 * what they purchased, and what active calls have reserved.
 */
export const BillingSummaryDtoSchema = z
  .object({
    organizationId: IdentifierSchema,
    plan: PlanTypeSchema,
    status: EffectiveSubscriptionStatusSchema,
    paidAccess: z.boolean(),
    catalogVersion: IdentifierSchema,
    currentPeriodEnd: z.string().datetime().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    includedSeconds: z.number().int().nonnegative(),
    purchasedSeconds: z.number().int().nonnegative(),
    reservedSeconds: z.number().int().nonnegative(),
    expiringSeconds: z.number().int().nonnegative(),
    topUpAvailable: z.boolean(),
    availableSeconds: z.number().int().nonnegative(),
    balanceStatus: CreditBalanceStatusSchema,
    entitlements: z.object({
      includedMinutes: z.number().int().nonnegative(),
      agents: z.number().int().nonnegative(),
      workspaces: z.number().int().nonnegative(),
      nangoConnections: z.number().int().nonnegative(),
      concurrentCalls: z.number().int().nonnegative(),
      outboundPstn: z.boolean(),
      campaigns: z.boolean(),
      whiteLabel: z.boolean(),
      pipelineMix: z
        .object({
          realtime: z.number().int().min(0).max(100),
          standard: z.number().int().min(0).max(100),
        })
        .strict(),
    }),
    usage: z.object({
      agents: z.number().int().nonnegative(),
      workspaces: z.number().int().nonnegative(),
      integrations: z.number().int().nonnegative(),
    }),
    blockedReason: EntitlementReasonSchema,
  })
  .strict();
export type BillingSummaryDto = z.infer<typeof BillingSummaryDtoSchema>;

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
  /**
   * Buying a PSTN number on VoiceForge's own carrier account. Distinct from
   * `outbound` (may this org place paid calls) and from `byo_telephony` (may it
   * bind a number it already pays for): this one spends platform money on a
   * recurring carrier rental, so it is the gate the provisioning route must
   * name in its refusal.
   */
  'managed_telephony',
]);
export type FeatureGate = z.infer<typeof FeatureGateSchema>;
