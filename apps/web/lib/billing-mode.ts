import type { CheckoutPlan } from '@voiceforge/shared';

export type WebBillingMode = 'demo' | 'live';

export interface DemoCheckoutFallback {
  mode: 'demo';
  checkoutAvailable: false;
  plan: CheckoutPlan;
  message: string;
  fallbackHref: string;
  fallbackLabel: string;
  salesHref: string;
}

type BillingModeEnv = Partial<
  Record<'BILLING_MODE' | 'NEXT_PUBLIC_BILLING_MODE', string | undefined>
>;

const DEMO_CHECKOUT_MESSAGE =
  'Stripe checkout is paused while the account is under review. Free trial and demo workspaces remain available.';

export function getBillingMode(
  env?: BillingModeEnv,
): WebBillingMode {
  const source = env ?? {
    BILLING_MODE: process.env.BILLING_MODE,
    NEXT_PUBLIC_BILLING_MODE: process.env.NEXT_PUBLIC_BILLING_MODE,
  };
  const mode = source.BILLING_MODE ?? source.NEXT_PUBLIC_BILLING_MODE;
  return mode === 'live' ? 'live' : 'demo';
}

export function isDemoBillingMode(
  env?: BillingModeEnv,
): boolean {
  return getBillingMode(env) === 'demo';
}

export function buildDemoCheckoutFallback(plan: CheckoutPlan): DemoCheckoutFallback {
  return {
    mode: 'demo',
    checkoutAvailable: false,
    plan,
    message: DEMO_CHECKOUT_MESSAGE,
    fallbackHref: '/dashboard/billing',
    fallbackLabel: 'Continue in demo',
    salesHref: `mailto:${process.env.NEXT_PUBLIC_SALES_EMAIL ?? 'sales@voiceforge.ai'}?subject=VoiceForge%20paid%20plan%20activation`,
  };
}

export function isDemoCheckoutFallback(value: unknown): value is DemoCheckoutFallback {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record['mode'] === 'demo' && record['checkoutAvailable'] === false;
}
