import { CHECKOUT_UNAVAILABLE_MESSAGE, CHECKOUT_UNAVAILABLE_TITLE } from '@/lib/billing-copy';

/**
 * Replaces the previous "demo billing" fallback.
 *
 * A missing or misconfigured Dodo Payments integration is an outage of the purchase
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

/**
 * Every field is checked, not just the discriminant: consumers render `title`
 * and use `salesHref` as the only escape hatch out of this state, so a partial
 * payload would render blank copy or an unusable link. `salesHref` is
 * restricted to `mailto:` so a malformed or hostile value cannot become an
 * arbitrary outbound link in the purchase path.
 */
export function isCheckoutUnavailable(value: unknown): value is CheckoutUnavailable {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record['checkoutAvailable'] !== false) return false;
  if (typeof record['message'] !== 'string' || record['message'].length === 0) return false;
  if (typeof record['title'] !== 'string' || record['title'].length === 0) return false;
  const salesHref = record['salesHref'];
  return typeof salesHref === 'string' && salesHref.startsWith('mailto:');
}

/** API error codes that mean "the purchase path is down", not "you are not allowed". */
const UNAVAILABLE_ERROR_CODES = new Set(['BILLING_UNAVAILABLE', 'SERVICE_UNAVAILABLE']);

export function isCheckoutUnavailableCode(code: string | undefined): boolean {
  return code !== undefined && UNAVAILABLE_ERROR_CODES.has(code);
}
