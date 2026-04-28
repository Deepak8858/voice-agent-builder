import { z } from 'zod';

// --------------------------------------------------------------------------
// Enums
// --------------------------------------------------------------------------

export const PlanTypeSchema = z.enum(['free', 'starter', 'growth', 'enterprise']);
export type PlanType = z.infer<typeof PlanTypeSchema>;

export const SubscriptionStatusSchema = z.enum([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const UsageTypeSchema = z.enum(['calls', 'minutes', 'tools', 'agents']);
export type UsageType = z.infer<typeof UsageTypeSchema>;

// --------------------------------------------------------------------------
// Plan limits
// --------------------------------------------------------------------------

export const PLAN_LIMITS = {
  free: {
    agents: 1,
    outboundCalls: 0,
    minutes: 0,
    tools: 0,
    workspaces: 1,
    contacts: 50,
    complianceBlocks: false,
  },
  starter: {
    agents: 3,
    outboundCalls: 100,
    minutes: 300,
    tools: 5,
    workspaces: 2,
    contacts: 500,
    complianceBlocks: false,
  },
  growth: {
    agents: 10,
    outboundCalls: 500,
    minutes: 2000,
    tools: 20,
    workspaces: 5,
    contacts: 5000,
    complianceBlocks: true,
  },
  enterprise: {
    agents: -1, // unlimited
    outboundCalls: -1,
    minutes: -1,
    tools: -1,
    workspaces: -1,
    contacts: -1,
    complianceBlocks: true,
  },
} as const;

export type PlanLimits = typeof PLAN_LIMITS;

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

export const CreateCheckoutSessionDtoSchema = z.object({
  priceId: z.string(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});
export type CreateCheckoutSessionDto = z.infer<typeof CreateCheckoutSessionDtoSchema>;

export const CreatePortalSessionDtoSchema = z.object({
  returnUrl: z.string().url().optional(),
});
export type CreatePortalSessionDto = z.infer<typeof CreatePortalSessionDtoSchema>;

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
]);
export type FeatureGate = z.infer<typeof FeatureGateSchema>;