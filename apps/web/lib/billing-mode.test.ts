import { describe, expect, it } from 'vitest';
import {
  buildDemoCheckoutFallback,
  getBillingMode,
  isDemoCheckoutFallback,
} from './billing-mode';

describe('billing mode helpers', () => {
  it('resolves billing mode from environment values', () => {
    expect(getBillingMode({ BILLING_MODE: 'demo' })).toBe('demo');
    expect(getBillingMode({ BILLING_MODE: 'live' })).toBe('live');
    expect(getBillingMode({})).toBe('demo');
  });

  it('builds and detects demo checkout fallback payloads', () => {
    const fallback = buildDemoCheckoutFallback('starter');

    expect(fallback.mode).toBe('demo');
    expect(fallback.checkoutAvailable).toBe(false);
    expect(fallback.plan).toBe('starter');
    expect(fallback.message).toMatch(/Stripe checkout is paused/i);
    expect(fallback.fallbackHref).toBe('/dashboard/billing');
    expect(isDemoCheckoutFallback(fallback)).toBe(true);
    expect(isDemoCheckoutFallback({ url: 'https://checkout.stripe.com/session' })).toBe(false);
  });
});
