import { PLAN_CATALOG } from '@voiceforge/shared';
import { siteUrl } from '@/lib/site-url';
import type { PricingFaqEntry } from '@/lib/billing-copy';

/**
 * Structured data for `/pricing`.
 *
 * Offer prices are derived from `PLAN_CATALOG` rather than restated here.
 * Google treats a `Product`/`Offer` price that disagrees with the visible page
 * price as invalid and drops the rich result; the previous hand-written values
 * had drifted to $49/$149/$499 while the page rendered $99/$299/$999.
 * `pricing-structured-data.test.ts` pins the two together.
 */
export function pricingProductJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'VoiceForge AI',
    description:
      'A spec-first voice AI operating system for building, testing, governing, and white-labeling AI voice agents.',
    brand: { '@type': 'Brand', name: 'VoiceForge AI' },
    url: `${siteUrl}/pricing`,
    offers: PLAN_CATALOG.map((plan) => ({
      '@type': 'Offer',
      name: plan.name,
      description: plan.tagline,
      price: String(plan.monthlyPriceUsd),
      priceCurrency: 'USD',
      url: `${siteUrl}/pricing`,
      availability: 'https://schema.org/InStock',
    })),
  };
}

/**
 * Builds `FAQPage` markup from the same copy the page renders. Google requires
 * FAQ markup to describe Q&A that is actually visible, so this must always be
 * called with the rendered list.
 */
export function faqPageJsonLd(faqs: readonly PricingFaqEntry[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a },
    })),
  };
}
