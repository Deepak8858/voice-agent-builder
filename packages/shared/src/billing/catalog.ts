import type { CheckoutPlan, PlanType } from '../schemas/billing';

/** The versioned commercial contract used by pricing, checkout, and runtime admission. */
export const BILLING_CATALOG_VERSION = '2026-07-24' as const;

export const MINUTE_PACK = {
  minutes: 100,
  priceUsd: 39,
  expiresAfterDays: 365,
} as const;

export interface PlanEntitlements {
  includedMinutes: number;
  lifetimeBrowserTestSeconds: number;
  agents: number;
  workspaces: number;
  nangoConnections: number;
  concurrentCalls: number;
  maximumContractConcurrentCalls: number;
  contacts: number;
  outboundPstn: boolean;
  campaigns: boolean;
  whiteLabel: boolean;
}

const PLAN_ENTITLEMENTS: Readonly<Record<PlanType, PlanEntitlements>> = {
  free: {
    includedMinutes: 0,
    lifetimeBrowserTestSeconds: 180,
    agents: 1,
    workspaces: 1,
    nangoConnections: 0,
    concurrentCalls: 0,
    maximumContractConcurrentCalls: 0,
    contacts: 50,
    outboundPstn: false,
    campaigns: false,
    whiteLabel: false,
  },
  starter: {
    includedMinutes: 200,
    lifetimeBrowserTestSeconds: 0,
    agents: 3,
    workspaces: 1,
    nangoConnections: 2,
    concurrentCalls: 2,
    maximumContractConcurrentCalls: 2,
    contacts: 500,
    outboundPstn: true,
    campaigns: true,
    whiteLabel: false,
  },
  growth: {
    includedMinutes: 1000,
    lifetimeBrowserTestSeconds: 0,
    agents: 10,
    workspaces: 5,
    nangoConnections: 10,
    concurrentCalls: 10,
    maximumContractConcurrentCalls: 10,
    contacts: 5_000,
    outboundPstn: true,
    campaigns: true,
    whiteLabel: true,
  },
  enterprise: {
    includedMinutes: 3000,
    lifetimeBrowserTestSeconds: 0,
    agents: 30,
    workspaces: 15,
    nangoConnections: 25,
    concurrentCalls: 25,
    maximumContractConcurrentCalls: 50,
    contacts: 25_000,
    outboundPstn: true,
    campaigns: true,
    whiteLabel: true,
  },
};

export function getPlanEntitlements(plan: PlanType): PlanEntitlements {
  return PLAN_ENTITLEMENTS[plan];
}

/**
 * Compatibility limits for callers that have not yet moved to explicit
 * entitlements. These aliases are derived from the commercial contract and
 * must not be used to introduce separate quota rules.
 */
interface CompatibilityPlanLimits {
  agents: number;
  outboundCalls: number;
  minutes: number;
  tools: number;
  workspaces: number;
  contacts: number;
  complianceBlocks: boolean;
}

function compatibilityLimits(entitlements: PlanEntitlements): CompatibilityPlanLimits {
  return {
    agents: entitlements.agents,
    outboundCalls: entitlements.concurrentCalls,
    minutes: entitlements.includedMinutes,
    tools: entitlements.nangoConnections,
    workspaces: entitlements.workspaces,
    contacts: entitlements.contacts,
    complianceBlocks: entitlements.campaigns,
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
    outboundCalls: string;
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
    tagline: 'One browser test before choosing a production plan.',
    priceLabel: '$0',
    monthlyPriceUsd: 0,
    interval: 'month',
    cta: 'Try in browser',
    dashboardCta: 'Current plan',
    features: ['One 180-second lifetime browser test', 'Compliance-safe sandbox runtime'],
    marketingLimits: {
      agents: '1 agent',
      minutes: '0 PSTN min',
      outboundCalls: '0 outbound calls',
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
      outboundCalls: '2 concurrent calls',
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
      outboundCalls: '10 concurrent calls',
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
    priceLabel: '$999',
    monthlyPriceUsd: 999,
    interval: 'month',
    cta: 'Contact sales',
    dashboardCta: 'Talk to sales',
    features: ['3,000 included minutes / month', '30 agents', 'Up to 50 contracted concurrent calls'],
    marketingLimits: {
      agents: '30 agents',
      minutes: '3,000 min/mo',
      outboundCalls: '25 concurrent calls (50 by contract)',
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
