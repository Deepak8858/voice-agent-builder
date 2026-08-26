import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG } from '@voiceforge/shared';
import { PRICING_FAQ } from '@/lib/billing-copy';
import { faqPageJsonLd, pricingProductJsonLd } from './pricing-structured-data';
import { siteUrl } from '@/lib/site-url';

/**
 * Structured-data accuracy contract.
 *
 * Google requires `Product`/`Offer` prices to match the price a user actually
 * sees on the page. Hand-written offer prices drifted from `PLAN_CATALOG`
 * ($49/$149/$499 in schema vs $99/$299/$999 on the page), which is a rich-result
 * disqualifier. These tests pin the schema to the catalog so the two cannot
 * diverge again.
 */
describe('pricingProductJsonLd', () => {
  const data = pricingProductJsonLd();

  it('is a valid Product node', () => {
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('Product');
    expect(data.name).toBe('VoiceForge AI');
  });

  it('publishes exactly one offer per catalog plan', () => {
    const offers = data.offers as Record<string, unknown>[];
    expect(offers).toHaveLength(PLAN_CATALOG.length);
  });

  it('takes every offer price from the plan catalog', () => {
    const offers = data.offers as Record<string, unknown>[];

    for (const plan of PLAN_CATALOG) {
      const offer = offers.find((candidate) => candidate.name === plan.name);
      expect(offer, `missing offer for ${plan.name}`).toBeDefined();
      expect(offer?.price).toBe(String(plan.monthlyPriceUsd));
      expect(offer?.priceCurrency).toBe('USD');
    }
  });

  it('matches the real published prices rather than the drifted values', () => {
    const offers = data.offers as Record<string, unknown>[];
    const priceFor = (name: string) => offers.find((offer) => offer.name === name)?.price;

    expect(priceFor('Starter')).toBe('99');
    expect(priceFor('Growth')).toBe('299');
    expect(priceFor('Enterprise')).toBe('999');
  });

  it('points every offer at the canonical pricing URL', () => {
    const offers = data.offers as Record<string, unknown>[];
    for (const offer of offers) {
      expect(offer.url).toBe(`${siteUrl}/pricing`);
    }
  });
});

describe('faqPageJsonLd', () => {
  it('mirrors the FAQ copy that is rendered on the page', () => {
    // FAQPage markup must only describe Q&A that is visible to the user.
    const data = faqPageJsonLd(PRICING_FAQ);
    const questions = data.mainEntity as Record<string, unknown>[];

    expect(data['@type']).toBe('FAQPage');
    expect(questions).toHaveLength(PRICING_FAQ.length);
    expect(questions.length).toBeGreaterThan(0);

    questions.forEach((question, index) => {
      expect(question['@type']).toBe('Question');
      expect(question.name).toBe(PRICING_FAQ[index].q);
      expect(question.acceptedAnswer).toStrictEqual({
        '@type': 'Answer',
        text: PRICING_FAQ[index].a,
      });
    });
  });
});
