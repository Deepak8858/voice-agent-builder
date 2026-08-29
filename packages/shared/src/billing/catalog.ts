import type { CheckoutPlan, PlanType, VoicePipeline } from '../schemas/billing';

/** The versioned commercial contract used by pricing, checkout, and runtime admission. */
export const BILLING_CATALOG_VERSION = '2026-08-23' as const;

export const MINUTE_PACK = {
  minutes: 100,
  priceUsd: 39,
  expiresAfterDays: 365,
} as const;

/**
 * The Free plan's monthly allowance. It is a *recurring* grant, not a lifetime
 * one, and it is spendable only on the in-house (`standard`) pipeline, whose
 * per-minute cost is an order of magnitude below the realtime pipeline. Granting
 * realtime minutes for free would sell the most expensive runtime at zero price.
 *
 * This allowance is the *only* browser-test budget. There is deliberately no
 * separate lifetime test grant: two independent allowances meant the recurring
 * one was unspendable, because a browser test is the only thing a Free
 * organization can start and it was capped by a one-time redemption.
 */
export const FREE_MONTHLY_MINUTES = 10 as const;

/**
 * Share of a plan's calls that run on each runtime pipeline. Percentages are
 * integers that must sum to 100 so a plan can never be defined with an
 * unroutable remainder.
 */
export interface PipelineMix {
  realtime: number;
  standard: number;
}

export interface PlanEntitlements {
  includedMinutes: number;
  agents: number;
  workspaces: number;
  nangoConnections: number;
  concurrentCalls: number;
  maximumContractConcurrentCalls: number;
  contacts: number;
  /**
   * Phone numbers an organization may hold at once, counting both provisioned
   * carrier numbers and registered BYO numbers.
   *
   * Deliberately equal to `concurrentCalls` on every paid plan: a number is an
   * inbound call lane, so holding more numbers than the plan can answer
   * concurrently buys nothing. Free is 0 rather than 1 because Free is refused
   * `managed_telephony` and `byo_telephony` outright, and a non-zero number here
   * would read as a telephony entitlement it does not have.
   *
   * Unlike the other quotas this one bounds *recurring platform spend*: a
   * provisioned number is rented on VoiceForge's own Twilio account at ~$1.15 a
   * month, so without a cap one paying Starter owner can loop `POST /provision`
   * and accrue unbounded carrier charges on the platform's card.
   */
  phoneNumbers: number;
  /**
   * Runtime split for this plan. Free is entirely in-house; Starter is split
   * evenly; Growth and Enterprise are entirely realtime.
   */
  pipelineMix: PipelineMix;
  outboundPstn: boolean;
  campaigns: boolean;
  /**
   * Compliance blocking (DNC, quiet hours, consent) is a mandatory safety
   * control, not a commercial feature. It is declared per plan so that it can
   * never be weakened as a side effect of repricing campaigns, and it is `true`
   * on every plan including Free.
   */
  complianceBlocks: boolean;
  whiteLabel: boolean;
}

const PLAN_ENTITLEMENTS: Readonly<Record<PlanType, PlanEntitlements>> = {
  free: {
    includedMinutes: FREE_MONTHLY_MINUTES,
    agents: 1,
    workspaces: 1,
    nangoConnections: 0,
    // One concurrent call, so the recurring free allowance is usable at all,
    // while a single organization still cannot fan out across the platform.
    concurrentCalls: 1,
    maximumContractConcurrentCalls: 1,
    contacts: 50,
    phoneNumbers: 0,
    pipelineMix: { realtime: 0, standard: 100 },
    outboundPstn: false,
    campaigns: false,
    complianceBlocks: true,
    whiteLabel: false,
  },
  starter: {
    includedMinutes: 200,
    agents: 3,
    workspaces: 1,
    nangoConnections: 2,
    concurrentCalls: 2,
    maximumContractConcurrentCalls: 2,
    contacts: 500,
    phoneNumbers: 2,
    pipelineMix: { realtime: 50, standard: 50 },
    outboundPstn: true,
    campaigns: true,
    complianceBlocks: true,
    whiteLabel: false,
  },
  growth: {
    includedMinutes: 1000,
    agents: 10,
    workspaces: 5,
    nangoConnections: 10,
    concurrentCalls: 10,
    maximumContractConcurrentCalls: 10,
    contacts: 5_000,
    phoneNumbers: 10,
    pipelineMix: { realtime: 100, standard: 0 },
    outboundPstn: true,
    campaigns: true,
    complianceBlocks: true,
    whiteLabel: true,
  },
  enterprise: {
    includedMinutes: 3000,
    agents: 30,
    workspaces: 15,
    nangoConnections: 25,
    concurrentCalls: 25,
    maximumContractConcurrentCalls: 50,
    contacts: 25_000,
    phoneNumbers: 25,
    pipelineMix: { realtime: 100, standard: 0 },
    outboundPstn: true,
    campaigns: true,
    complianceBlocks: true,
    whiteLabel: true,
  },
};

export function getPlanEntitlements(plan: PlanType): PlanEntitlements {
  return PLAN_ENTITLEMENTS[plan];
}

/**
 * Pipelines a plan is *allowed* to use. A plan with a 0% share of a pipeline is
 * not merely unlikely to be routed there — it must never be routed there, so
 * admission and routing can both derive the rule from one place instead of
 * restating it.
 */
export function allowedPipelines(plan: PlanType): readonly VoicePipeline[] {
  const mix = PLAN_ENTITLEMENTS[plan].pipelineMix;
  const allowed: VoicePipeline[] = [];
  if (mix.realtime > 0) allowed.push('realtime');
  if (mix.standard > 0) allowed.push('standard');
  return allowed;
}

export function isPipelineAllowed(plan: PlanType, pipeline: VoicePipeline): boolean {
  return allowedPipelines(plan).includes(pipeline);
}

/**
 * Compatibility limits for callers that have not yet moved to explicit
 * entitlements. These aliases are derived from the commercial contract and
 * must not be used to introduce separate quota rules.
 */
interface CompatibilityPlanLimits {
  agents: number;
  concurrentCalls: number;
  minutes: number;
  tools: number;
  workspaces: number;
  contacts: number;
  complianceBlocks: boolean;
}

function compatibilityLimits(entitlements: PlanEntitlements): CompatibilityPlanLimits {
  return {
    agents: entitlements.agents,
    concurrentCalls: entitlements.concurrentCalls,
    minutes: entitlements.includedMinutes,
    tools: entitlements.nangoConnections,
    workspaces: entitlements.workspaces,
    contacts: entitlements.contacts,
    complianceBlocks: entitlements.complianceBlocks,
  };
}

export const PLAN_LIMITS: Readonly<Record<PlanType, CompatibilityPlanLimits>> = {
  free: compatibilityLimits(PLAN_ENTITLEMENTS.free),
  starter: compatibilityLimits(PLAN_ENTITLEMENTS.starter),
  growth: compatibilityLimits(PLAN_ENTITLEMENTS.growth),
  enterprise: compatibilityLimits(PLAN_ENTITLEMENTS.enterprise),
};

export type BillingInterval = 'month' | 'year';

export interface PlanCatalogEntry {
  id: PlanType;
  name: string;
  tagline: string;
  priceLabel: string;
  monthlyPriceUsd: number;
  interval: BillingInterval;
  highlight?: boolean;
  cta: string;
  dashboardCta?: string;
  features: string[];
  marketingLimits: {
    agents: string;
    minutes: string;
    concurrentCalls: string;
    tools: string;
    workspaces: string;
    contacts: string;
    advancedCompliance: boolean;
  };
}

export const PLAN_CATALOG: readonly PlanCatalogEntry[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Ten minutes a month on our own low-latency voice pipeline.',
    priceLabel: '$0',
    monthlyPriceUsd: 0,
    interval: 'month',
    cta: 'Start free',
    dashboardCta: 'Current plan',
    features: [
      `${FREE_MONTHLY_MINUTES} free minutes every month`,
      'VoiceForge in-house pipeline (streaming STT, LLM, TTS)',
      'Browser tests draw from your monthly minutes',
      'Compliance blocking on every call',
    ],
    marketingLimits: {
      agents: '1 agent',
      minutes: `${FREE_MONTHLY_MINUTES} min/mo`,
      concurrentCalls: '1 concurrent call',
      tools: '0 integrations',
      workspaces: '1 workspace',
      contacts: '50 contacts',
      advancedCompliance: false,
    },
  },
  {
    id: 'starter',
    name: 'Starter',
    tagline: 'For teams launching their first production voice agents.',
    priceLabel: '$99',
    monthlyPriceUsd: 99,
    interval: 'month',
    highlight: true,
    cta: 'Upgrade to Starter',
    dashboardCta: 'Upgrade to Starter',
    features: ['200 included minutes / month', '3 agents', '2 Nango connections', '2 concurrent calls'],
    marketingLimits: {
      agents: '3 agents',
      minutes: '200 min/mo',
      concurrentCalls: '2 concurrent calls',
      tools: '2 integrations',
      workspaces: '1 workspace',
      contacts: '500 contacts',
      advancedCompliance: true,
    },
  },
  {
    id: 'growth',
    name: 'Growth',
    tagline: 'For growing operations that need scale and white-label delivery.',
    priceLabel: '$299',
    monthlyPriceUsd: 299,
    interval: 'month',
    cta: 'Upgrade to Growth',
    dashboardCta: 'Upgrade to Growth',
    features: ['1,000 included minutes / month', '10 agents', '10 concurrent calls', 'White-label branding'],
    marketingLimits: {
      agents: '10 agents',
      minutes: '1,000 min/mo',
      concurrentCalls: '10 concurrent calls',
      tools: '10 integrations',
      workspaces: '5 workspaces',
      contacts: '5,000 contacts',
      advancedCompliance: true,
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Sales-assisted rollout for larger organizations and contract needs.',
    priceLabel: 'From $999/month',
    monthlyPriceUsd: 999,
    interval: 'month',
    cta: 'Contact sales',
    dashboardCta: 'Talk to sales',
    features: ['3,000 included minutes / month', '30 agents', 'Up to 50 contracted concurrent calls'],
    marketingLimits: {
      agents: '30 agents',
      minutes: '3,000 min/mo',
      concurrentCalls: '25 concurrent calls (50 by contract)',
      tools: '25 integrations',
      workspaces: '15 workspaces',
      contacts: '25,000 contacts',
      advancedCompliance: true,
    },
  },
];

const PLAN_ORDER: PlanType[] = ['free', 'starter', 'growth', 'enterprise'];

export function getPlanById(id: PlanType): PlanCatalogEntry | undefined {
  return PLAN_CATALOG.find((plan) => plan.id === id);
}

export function isPaidPlan(plan: PlanType): boolean {
  return plan !== 'free';
}

export function isCheckoutPlan(plan: PlanType): plan is CheckoutPlan {
  return plan === 'starter' || plan === 'growth';
}

/** Returns the next self-service upgrade tier, if one is available. */
export function getUpgradeTarget(current: PlanType): CheckoutPlan | null {
  const idx = PLAN_ORDER.indexOf(current);
  for (let i = idx + 1; i < PLAN_ORDER.length; i += 1) {
    const next = PLAN_ORDER[i];
    if (isCheckoutPlan(next)) return next;
  }
  return null;
}

export function getPlanLimits(plan: PlanType): CompatibilityPlanLimits {
  return PLAN_LIMITS[plan];
}

export function comparePlans(a: PlanType, b: PlanType): number {
  return PLAN_ORDER.indexOf(a) - PLAN_ORDER.indexOf(b);
}
