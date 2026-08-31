import { describe, expect, it } from 'vitest';
import {
  buildCheckoutUnavailable,
  isCheckoutUnavailable,
  isCheckoutUnavailableCode,
} from './checkout-availability';

describe('checkout availability', () => {
  it('builds a temporary-unavailable payload without demo or trial claims', () => {
    const payload = buildCheckoutUnavailable();

    expect(payload.checkoutAvailable).toBe(false);
    expect(payload.title).toMatch(/temporarily unavailable/i);
    expect(payload.message).not.toMatch(/demo/i);
    expect(payload.message).not.toMatch(/trial/i);
    expect(payload.salesHref).toMatch(/^mailto:/);
  });

  it('never offers a "continue in demo" escape hatch', () => {
    const payload = buildCheckoutUnavailable() as unknown as Record<string, unknown>;

    expect(payload['fallbackHref']).toBeUndefined();
    expect(payload['fallbackLabel']).toBeUndefined();
  });

  it('recognises its own payload and rejects checkout URLs', () => {
    expect(isCheckoutUnavailable(buildCheckoutUnavailable())).toBe(true);
    expect(isCheckoutUnavailable({ url: 'https://checkout.dodopayments.com/buy/pdt_123' })).toBe(
      false,
    );
    expect(isCheckoutUnavailable(null)).toBe(false);
    expect(isCheckoutUnavailable({ checkoutAvailable: false })).toBe(false);
  });

  it('treats only billing-outage codes as unavailable', () => {
    expect(isCheckoutUnavailableCode('BILLING_UNAVAILABLE')).toBe(true);
    expect(isCheckoutUnavailableCode('SERVICE_UNAVAILABLE')).toBe(true);
    expect(isCheckoutUnavailableCode('PLAN_LIMIT_EXCEEDED')).toBe(false);
    expect(isCheckoutUnavailableCode(undefined)).toBe(false);
  });
});
