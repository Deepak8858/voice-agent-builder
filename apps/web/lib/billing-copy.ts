import {
  BILLING_CATALOG_VERSION,
  MINUTE_PACK,
  getPlanById,
  getPlanEntitlements,
} from '@voiceforge/shared';

/**
 * Single source of pricing and billing surface copy.
 *
 * Marketing copy is a commercial contract: what the pricing page promises has
 * to match what the credit ledger actually enforces. Keeping the strings here
 * (instead of inline in JSX) lets `billing-copy.test.ts` assert both that the
 * numbers are derived from the shared catalog and that retired claims —
 * unlimited usage, annual rollover, free inbound calls, a 14-day Starter
 * trial, HIPAA readiness, SLAs, multi-region — never reappear.
 */

const free = getPlanEntitlements('free');
const starter = getPlanEntitlements('starter');
const growth = getPlanEntitlements('growth');
const enterprise = getPlanEntitlements('enterprise');

/**
 * Free's browser-test budget is simply its monthly allowance. There is no
 * separate lifetime test grant, so the copy must not describe one.
 */
const FREE_MONTHLY_MINUTES = free.includedMinutes;
/** 365 days expressed in whole months for customer-facing copy. */
const PACK_EXPIRY_MONTHS = Math.round(MINUTE_PACK.expiresAfterDays / 30.44);

export const BILLING_COPY_CATALOG_VERSION = BILLING_CATALOG_VERSION;

/** Label used everywhere a prepaid pack purchase is offered. */
export const MINUTE_PACK_LABEL = `Buy ${MINUTE_PACK.minutes} minutes — $${MINUTE_PACK.priceUsd}`;

/**
 * Shown when Stripe is not configured or the API reports billing as
 * unavailable. It never implies that recurring free minutes are granted.
 */
export const CHECKOUT_UNAVAILABLE_TITLE = 'Checkout is temporarily unavailable';
export const CHECKOUT_UNAVAILABLE_MESSAGE =
  'Plan changes and prepaid minute packs cannot be purchased right now. Existing plans, balances, and running calls are unaffected. Contact sales if you need to buy immediately.';

/** Statements the billing surfaces are required to make. */
export const BILLING_DISCLOSURES: readonly string[] = [
  `Free includes ${FREE_MONTHLY_MINUTES} browser test minutes each month, which reset monthly and do not accumulate. Free has no phone number and cannot place or receive PSTN calls.`,
  'Every started connected minute is charged, rounded up to the whole minute.',
  'Calls that are never answered use zero VoiceForge minutes.',
  'Included minutes reset each billing period and do not roll over.',
  `Prepaid packs are ${MINUTE_PACK.minutes} minutes for $${MINUTE_PACK.priceUsd} and expire ${PACK_EXPIRY_MONTHS} months after purchase.`,
  'Twilio or VoBiz telephony charges are separate and are paid by you directly to that provider.',
  'Enterprise is sales-assisted and is not purchasable through self-serve checkout.',
];

export interface FeatureComparisonRow {
  feature: string;
  free: boolean | string;
  starter: boolean | string;
  growth: boolean | string;
  enterprise: boolean | string;
}

export const FEATURE_COMPARISON: readonly FeatureComparisonRow[] = [
  {
    feature: 'Included voice minutes',
    // Free's minutes are real included minutes, but they are browser-test only
    // because the plan carries no PSTN entitlement.
    free: `${free.includedMinutes}/mo (browser test only)`,
    starter: `${starter.includedMinutes.toLocaleString('en-US')}/mo`,
    growth: `${growth.includedMinutes.toLocaleString('en-US')}/mo`,
    enterprise: `${enterprise.includedMinutes.toLocaleString('en-US')}/mo`,
  },
  {
    feature: 'Browser test',
    free: 'Uses included minutes',
    starter: 'Uses included minutes',
    growth: 'Uses included minutes',
    enterprise: 'Uses included minutes',
  },
  {
    feature: 'Outbound PSTN calling',
    free: free.outboundPstn,
    starter: starter.outboundPstn,
    growth: growth.outboundPstn,
    enterprise: enterprise.outboundPstn,
  },
  {
    feature: 'Agents',
    free: String(free.agents),
    starter: String(starter.agents),
    growth: String(growth.agents),
    enterprise: String(enterprise.agents),
  },
  {
    feature: 'Concurrent calls',
    free: String(free.concurrentCalls),
    starter: String(starter.concurrentCalls),
    growth: String(growth.concurrentCalls),
    enterprise: `${enterprise.concurrentCalls} (${enterprise.maximumContractConcurrentCalls} by contract)`,
  },
  {
    feature: 'Workspaces',
    free: String(free.workspaces),
    starter: String(starter.workspaces),
    growth: String(growth.workspaces),
    enterprise: String(enterprise.workspaces),
  },
  {
    feature: 'Integration connections',
    free: String(free.nangoConnections),
    starter: String(starter.nangoConnections),
    growth: String(growth.nangoConnections),
    enterprise: String(enterprise.nangoConnections),
  },
  {
    feature: 'Contacts',
    free: free.contacts.toLocaleString('en-US'),
    starter: starter.contacts.toLocaleString('en-US'),
    growth: growth.contacts.toLocaleString('en-US'),
    enterprise: enterprise.contacts.toLocaleString('en-US'),
  },
  {
    feature: 'Campaigns',
    free: free.campaigns,
    starter: starter.campaigns,
    growth: growth.campaigns,
    enterprise: enterprise.campaigns,
  },
  {
    feature: 'White-label',
    free: free.whiteLabel,
    starter: starter.whiteLabel,
    growth: 'Custom domain',
    enterprise: 'Custom domain',
  },
  {
    feature: 'Prepaid minute packs',
    free: false,
    starter: true,
    growth: true,
    enterprise: true,
  },
];

export interface PricingFaqEntry {
  q: string;
  a: string;
}

export const PRICING_FAQ: readonly PricingFaqEntry[] = [
  {
    q: 'What counts as a voice minute?',
    a: 'Connected call time on outbound and inbound PSTN calls, plus browser test time. Every started minute is charged, so a call lasting 61 seconds uses 2 minutes. Calls that are never answered use zero VoiceForge minutes.',
  },
  {
    q: 'What does Free actually include?',
    a: `Free includes ${FREE_MONTHLY_MINUTES} minutes each month for browser tests, which run on our in-house voice pipeline. It does not include a phone number, and it cannot place or receive PSTN calls. A paid plan is required for telephony.`,
  },
  {
    q: 'What happens to unused included minutes?',
    a: 'Included minutes reset at the start of each billing period and do not roll over. Only prepaid minute packs carry a balance forward.',
  },
  {
    q: 'What happens when I run out of included minutes?',
    a: `Buy a prepaid pack of ${MINUTE_PACK.minutes} minutes for $${MINUTE_PACK.priceUsd}. Packs are consumed after included minutes and expire ${PACK_EXPIRY_MONTHS} months after purchase.`,
  },
  {
    q: 'Are Twilio or VoBiz charges included?',
    a: 'No. You bring your own telephony account. Twilio or VoBiz bills you directly for numbers and carrier minutes; VoiceForge only charges for VoiceForge minutes.',
  },
  {
    q: 'Can I change plans later?',
    a: 'Yes. Upgrade or downgrade at any time. Upgrades take effect once Stripe confirms the payment; downgrades apply at the next billing cycle.',
  },
  {
    q: 'How long does a purchase take to appear?',
    a: 'Checkout returns immediately, but plan and balance changes are applied only after Stripe confirms the payment through a verified webhook. The return page keeps polling until the confirmed state arrives.',
  },
  {
    q: 'What about compliance?',
    a: 'All plans apply DNC, DND, and consent checks before dialing. Growth and Enterprise add advanced compliance blocks for regulated calling programs.',
  },
  {
    q: 'How do I buy Enterprise?',
    a: `Enterprise is sales-assisted. Pricing starts at ${getPlanById('enterprise')?.priceLabel ?? '$999/month'} and is agreed by contract, including concurrency above the standard limit.`,
  },
];

/**
 * Claims that must never ship again. Each entry is matched case-insensitively
 * against the rendered copy by `billing-copy.test.ts`.
 */
export const DISALLOWED_PRICING_CLAIMS: readonly RegExp[] = [
  /unlimited/i,
  /roll\s*over/i,
  /rollover/i,
  /inbound calls are free/i,
  /free inbound/i,
  /14[-\s]day/i,
  /free trial/i,
  /hipaa/i,
  /\bsla\b/i,
  /service[-\s]level agreement/i,
  /multi[-\s]region/i,
  /\bdemo billing\b/i,
];

/**
 * Copy is allowed to *deny* a retired claim (for example "do not roll over").
 * These negations are stripped before the disallowed-claim scan runs.
 */
const ALLOWED_NEGATIONS: readonly RegExp[] = [
  /do not roll over/gi,
  /does not roll over/gi,
];

export function stripAllowedNegations(text: string): string {
  return ALLOWED_NEGATIONS.reduce((acc, pattern) => acc.replace(pattern, ''), text);
}

/** Returns every disallowed claim found in the supplied copy. */
export function findDisallowedClaims(text: string): string[] {
  const scannable = stripAllowedNegations(text);
  return DISALLOWED_PRICING_CLAIMS.filter((pattern) => pattern.test(scannable)).map(
    (pattern) => pattern.source,
  );
}
