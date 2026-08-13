import { CHECKOUT_UNAVAILABLE_MESSAGE, CHECKOUT_UNAVAILABLE_TITLE } from '@/lib/billing-copy';

/**
 * Replaces the previous "demo billing" fallback.
 *
 * A missing or misconfigured Stripe integration is an outage of the purchase
 * path, not a product tier: it must never imply that recurring free minutes,
 * a trial, or demo entitlements have been activated. Callers surface this
 * payload as a temporary-unavailable state with a sales escape hatch.
 */
export interface CheckoutUnavailable {
  checkoutAvailable: false;
  title: string;
  message: string;
  salesHref: string;
}

const SALES_EMAIL = process.env.NEXT_PUBLIC_SALES_EMAIL ?? 'sales@voiceforge.ai';

/**
 * The message is deliberately not taken from the API. Server-side billing
 * status strings still describe a "demo" with "free trial limits", which is
 * exactly the claim this state must not make.
 */
export function buildCheckoutUnavailable(): CheckoutUnavailable {
  return {
    checkoutAvailable: false,
    title: CHECKOUT_UNAVAILABLE_TITLE,
    message: CHECKOUT_UNAVAILABLE_MESSAGE,
    salesHref: `mailto:${SALES_EMAIL}?subject=VoiceForge%20purchase%20assistance`,
  };
}

export function isCheckoutUnavailable(value: unknown): value is CheckoutUnavailable {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record['checkoutAvailable'] === false && typeof record['message'] === 'string';
}

/** API error codes that mean "the purchase path is down", not "you are not allowed". */
const UNAVAILABLE_ERROR_CODES = new Set(['BILLING_UNAVAILABLE', 'SERVICE_UNAVAILABLE']);

export function isCheckoutUnavailableCode(code: string | undefined): boolean {
  return code !== undefined && UNAVAILABLE_ERROR_CODES.has(code);
}
