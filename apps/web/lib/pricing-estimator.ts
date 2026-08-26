import {
  PLAN_CATALOG,
  PLAN_LIMITS,
  getPlanById,
  type PlanType,
} from '@voiceforge/shared';

export interface PricingEstimateInput {
  agents: number;
  minutes: number;
  concurrentCalls: number;
  tools: number;
  workspaces: number;
  contacts: number;
}

export interface PricingEstimate {
  planId: PlanType;
  planName: string;
  priceLabel: string;
  monthlyPriceUsd: number;
  exceeded: Array<keyof PricingEstimateInput>;
}

const PLAN_ORDER: PlanType[] = ['free', 'starter', 'growth', 'enterprise'];

export function estimatePlan(input: PricingEstimateInput): PricingEstimate {
  const normalized = normalizeInput(input);
  for (const planId of PLAN_ORDER) {
    if (fitsPlan(planId, normalized)) {
      return buildEstimate(planId, normalized);
    }
  }
  return buildEstimate('enterprise', normalized);
}

export function formatEstimateReason(estimate: PricingEstimate): string {
  if (estimate.planId === 'enterprise') {
    return 'Usage requires a sales-assisted Enterprise plan.';
  }
  if (estimate.planId === 'free') {
    return 'Usage fits the Free browser-test entitlement.';
  }
  return `Usage fits the ${estimate.planName} plan limits.`;
}

function normalizeInput(input: PricingEstimateInput): PricingEstimateInput {
  return {
    agents: nonNegativeInt(input.agents),
    minutes: nonNegativeInt(input.minutes),
    concurrentCalls: nonNegativeInt(input.concurrentCalls),
    tools: nonNegativeInt(input.tools),
    workspaces: nonNegativeInt(input.workspaces),
    contacts: nonNegativeInt(input.contacts),
  };
}

function fitsPlan(planId: PlanType, input: PricingEstimateInput): boolean {
  const limits = PLAN_LIMITS[planId];
  return (
    within(input.agents, limits.agents) &&
    within(input.minutes, limits.minutes) &&
    within(input.concurrentCalls, limits.concurrentCalls) &&
    within(input.tools, limits.tools) &&
    within(input.workspaces, limits.workspaces) &&
    within(input.contacts, limits.contacts)
  );
}

function buildEstimate(planId: PlanType, input: PricingEstimateInput): PricingEstimate {
  const plan = getPlanById(planId) ?? PLAN_CATALOG[0];
  const limits = PLAN_LIMITS[planId];
  const exceeded = ([
    ['agents', limits.agents],
    ['minutes', limits.minutes],
    ['concurrentCalls', limits.concurrentCalls],
    ['tools', limits.tools],
    ['workspaces', limits.workspaces],
    ['contacts', limits.contacts],
  ] as const)
    .filter(([key, limit]) => !within(input[key], limit))
    .map(([key]) => key);

  return {
    planId,
    planName: plan.name,
    priceLabel: plan.priceLabel,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    exceeded,
  };
}

function within(value: number, limit: number): boolean {
  return value <= limit;
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
