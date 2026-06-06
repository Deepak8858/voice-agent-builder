import assert from 'node:assert/strict';
import {
  buildDemoCheckoutFallback,
  getBillingMode,
  isDemoCheckoutFallback,
} from './billing-mode';

assert.equal(getBillingMode({ BILLING_MODE: 'demo' }), 'demo');
assert.equal(getBillingMode({ BILLING_MODE: 'live' }), 'live');
assert.equal(getBillingMode({}), 'demo');

const fallback = buildDemoCheckoutFallback('starter');

assert.equal(fallback.mode, 'demo');
assert.equal(fallback.checkoutAvailable, false);
assert.equal(fallback.plan, 'starter');
assert.match(fallback.message, /Stripe checkout is paused/i);
assert.equal(fallback.fallbackHref, '/dashboard/billing');
assert.equal(isDemoCheckoutFallback(fallback), true);
assert.equal(isDemoCheckoutFallback({ url: 'https://checkout.stripe.com/session' }), false);
