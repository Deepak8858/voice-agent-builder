import { describe, expect, it } from 'vitest';
import { BILLING_CATALOG_VERSION, MINUTE_PACK, getPlanEntitlements } from '@voiceforge/shared';
import {
  BILLING_COPY_CATALOG_VERSION,
  BILLING_DISCLOSURES,
  CHECKOUT_UNAVAILABLE_MESSAGE,
  CHECKOUT_UNAVAILABLE_TITLE,
  FEATURE_COMPARISON,
  MINUTE_PACK_LABEL,
  PRICING_FAQ,
  findDisallowedClaims,
} from './billing-copy';

function allCopy(): string {
  return [
    MINUTE_PACK_LABEL,
    CHECKOUT_UNAVAILABLE_TITLE,
    CHECKOUT_UNAVAILABLE_MESSAGE,
    ...BILLING_DISCLOSURES,
    ...FEATURE_COMPARISON.flatMap((row) =>
      [row.feature, row.free, row.starter, row.growth, row.enterprise].filter(
        (value): value is string => typeof value === 'string',
      ),
    ),
    ...PRICING_FAQ.flatMap((entry) => [entry.q, entry.a]),
  ].join('\n');
}

describe('billing copy', () => {
  it('tracks the shared catalog version', () => {
    expect(BILLING_COPY_CATALOG_VERSION).toBe(BILLING_CATALOG_VERSION);
  });

  it('never reintroduces retired pricing claims', () => {
    expect(findDisallowedClaims(allCopy())).toEqual([]);
  });

  it('detects a retired claim if one is reintroduced', () => {
    expect(findDisallowedClaims('Starter plans include a 14-day free trial.')).toEqual(
      expect.arrayContaining(['14[-\\s]day', 'free trial']),
    );
    expect(findDisallowedClaims('Annual plans include rollover for unused minutes.')).not.toEqual(
      [],
    );
    expect(findDisallowedClaims('Inbound calls are free.')).not.toEqual([]);
    expect(findDisallowedClaims('HIPAA-ready')).not.toEqual([]);
    expect(findDisallowedClaims('Unlimited everything')).not.toEqual([]);
  });

  it('still allows copy that denies rollover', () => {
    expect(
      findDisallowedClaims('Included minutes reset each billing period and do not roll over.'),
    ).toEqual([]);
  });

  it('states the Free monthly allowance and the PSTN exclusion', () => {
    const free = getPlanEntitlements('free');
    const copy = allCopy();

    expect(free.includedMinutes).toBe(10);
    expect(copy).toContain(`${free.includedMinutes} browser test minutes each month`);
    expect(copy).toMatch(/cannot place or receive PSTN calls/i);
  });

  /**
   * Free's allowance recurs, so copy promising a single lifetime test would
   * understate what the ledger actually grants and would resurrect the cap that
   * made those minutes unspendable.
   */
  it('never describes the browser test as a one-time lifetime grant', () => {
    const copy = allCopy();

    expect(copy).not.toMatch(/lifetime/i);
    expect(copy).not.toMatch(/one (?:browser )?test/i);
    expect(copy).not.toMatch(/180 seconds/);
  });

  it('states started-minute rounding and zero-charge unanswered calls', () => {
    const copy = allCopy();

    expect(copy).toMatch(/every started connected minute is charged/i);
    expect(copy).toMatch(/never answered use zero VoiceForge minutes/i);
  });

  it('states pack size, price, and expiry from the catalog', () => {
    const copy = allCopy();

    expect(MINUTE_PACK_LABEL).toBe(`Buy ${MINUTE_PACK.minutes} minutes — $${MINUTE_PACK.priceUsd}`);
    expect(MINUTE_PACK.expiresAfterDays).toBe(365);
    expect(copy).toContain('expire 12 months after purchase');
  });

  it('discloses that carrier charges are billed separately', () => {
    expect(allCopy()).toMatch(/Twilio or VoBiz bills you directly/i);
  });

  it('describes Enterprise as sales-assisted', () => {
    expect(allCopy()).toMatch(/Enterprise is sales-assisted/i);
  });

  it('says checkout return waits for webhook-confirmed state', () => {
    expect(allCopy()).toMatch(
      /only after Dodo Payments confirms the payment through a verified webhook/i,
    );
  });

  it('renders comparison values straight from plan entitlements', () => {
    const minutes = FEATURE_COMPARISON.find((row) => row.feature === 'Included voice minutes');
    const agents = FEATURE_COMPARISON.find((row) => row.feature === 'Agents');
    const outbound = FEATURE_COMPARISON.find((row) => row.feature === 'Outbound PSTN calling');

    expect(minutes?.starter).toBe('200/mo');
    expect(minutes?.growth).toBe('1,000/mo');
    expect(minutes?.enterprise).toBe('3,000/mo');
    expect(agents?.starter).toBe(String(getPlanEntitlements('starter').agents));
    expect(outbound?.free).toBe(false);
    expect(outbound?.starter).toBe(true);
  });

  it('keeps the unavailable-checkout message free of entitlement promises', () => {
    expect(CHECKOUT_UNAVAILABLE_MESSAGE).not.toMatch(/trial/i);
    expect(CHECKOUT_UNAVAILABLE_MESSAGE).toMatch(/temporarily|right now/i);
    expect(CHECKOUT_UNAVAILABLE_MESSAGE).toMatch(/balances, and running calls are unaffected/i);
  });
});
