import type { CheckoutPlan, PlanType } from '../schemas/billing';
import { PLAN_LIMITS } from '../schemas/billing';

/**
 * Centralized plan catalog. The frontend pricing page and dashboard billing
 * panel both consume this so that display copy, prices, and limits stay in a
 * single source of truth. Price IDs themselves stay server-side (env vars).
 */

export type BillingInterval = 'month' | 'year';

export interface PlanCatalogEntry {
  id: PlanType;
  /** Pretty display name (e.g. "Starter"). */
  name: string;
  /** Short one-line tagline that appears under the plan name. */
  tagline: string;
  /** Human-readable price string, e.g. "$49". `null` for free. */
  priceLabel: string;
  /** Monthly USD price (integer dollars) used for any math we need. `null` for free, undefined for custom. */
  monthlyPriceUsd: number | null;
  /** Billing interval that the headline price refers to. */
  interval: BillingInterval | null;
  /** Whether this plan is the highlighted "most popular" tier on the pricing page. */
  highlight?: boolean;
  /** Headline call-to-action shown on the pricing card for new visitors. */
  cta: string;
  /** Headline CTA shown on the dashboard for upgrade/downgrade behavior. */
  dashboardCta?: string;
  /** Feature bullet list used in pricing cards. */
  features: string[];
  /** Plan-level marketing limits / quotas. */
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
    tagline: 'Explore VoiceForge with a free trial, no card required.',
    priceLabel: '$0',
    monthlyPriceUsd: 0,
    interval: 'month',
    cta: 'Start free',
    dashboardCta: 'Current plan',
    features: [
      'AI agent generation from a plain-language brief',
      'Browser test calls against a sandbox runtime',
      'Compliance gating (consent, DNC, opt-outs)',
      'Workspace knowledge base',
      'Email support',
    ],
    marketingLimits: {
      agents: '1 agent',
      minutes: '10 trial minutes',
      outboundCalls: '5 trial calls',
      tools: '2 tools',
      workspaces: '1 workspace',
      contacts: '50 contacts',
      advancedCompliance: false,
    },
  },
  {
    id: 'starter',
    name: 'Starter',
    tagline: 'For solo operators and small teams running real outbound calls.',
    priceLabel: '$49',
    monthlyPriceUsd: 49,
    interval: 'month',
    highlight: true,
    cta: 'Upgrade to Starter',
    dashboardCta: 'Upgrade to Starter',
    features: [
      'Everything in Free',
      '300 outbound voice minutes / month',
      'Up to 3 published agents',
      'White-label subdomain',
      'API access',
      'Priority email support',
    ],
    marketingLimits: {
      agents: '3 agents',
      minutes: '300 min/mo',
      outboundCalls: '100 calls/mo',
      tools: '5 tools per agent',
      workspaces: '2 workspaces',
      contacts: '500 contacts',
      advancedCompliance: false,
    },
  },
  {
    id: 'growth',
    name: 'Growth',
    tagline: 'For agencies and growing teams scaling voice operations.',
    priceLabel: '$149',
    monthlyPriceUsd: 149,
    interval: 'month',
    cta: 'Upgrade to Growth',
    dashboardCta: 'Upgrade to Growth',
    features: [
      'Everything in Starter',
      '2,000 outbound voice minutes / month',
      'Up to 10 published agents',
      'Custom-domain white label',
      'Bulk CSV contact import',
      'Advanced compliance blocks',
      'Calendar integrations (Google, Cal.com)',
    ],
    marketingLimits: {
      agents: '10 agents',
      minutes: '2,000 min/mo',
      outboundCalls: '500 calls/mo',
      tools: '20 tools per agent',
      workspaces: '5 workspaces',
      contacts: '5,000 contacts',
      advancedCompliance: true,
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For organizations with advanced needs and dedicated rollout.',
    priceLabel: 'Custom',
    monthlyPriceUsd: null,
    interval: null,
    cta: 'Contact sales',
    dashboardCta: 'Talk to sales',
    features: [
      'Everything in Growth',
      'Unlimited everything',
      'Dedicated account manager and SLA',
      'HIPAA-ready infrastructure',
      'SSO / SAML',
      'Audit log + compliance exports',
      'Multi-region deployment',
    ],
    marketingLimits: {
      agents: 'Unlimited',
      minutes: 'Unlimited',
      outboundCalls: 'Unlimited',
      tools: 'Unlimited',
      workspaces: 'Unlimited',
      contacts: 'Unlimited',
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
  return plan === 'starter' || plan === 'growth' || plan === 'enterprise';
}

/**
 * Returns the next plan a customer is most likely to upgrade to. Returns
 * `null` when the customer is already on the top tier.
 */
export function getUpgradeTarget(current: PlanType): CheckoutPlan | null {
  const idx = PLAN_ORDER.indexOf(current);
  for (let i = idx + 1; i < PLAN_ORDER.length; i += 1) {
    const next = PLAN_ORDER[i];
    if (isCheckoutPlan(next)) return next;
  }
  return null;
}

/**
 * Returns plan-level marketing limits for display purposes. Use `PLAN_LIMITS`
 * directly when enforcing limits server-side.
 */
export function getPlanLimits(plan: PlanType): typeof PLAN_LIMITS[PlanType] {
  return PLAN_LIMITS[plan];
}

/**
 * Compares two plans by tier order. Returns a negative number if `a` is below
 * `b`, positive if `a` is above `b`, and zero if equal.
 */
export function comparePlans(a: PlanType, b: PlanType): number {
  return PLAN_ORDER.indexOf(a) - PLAN_ORDER.indexOf(b);
}
