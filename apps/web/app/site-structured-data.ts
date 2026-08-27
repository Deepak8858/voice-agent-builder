import { siteUrl } from '@/lib/site-url';

/**
 * Site-wide entity markup, rendered from the root layout so it appears on every
 * page.
 *
 * `Organization` gives Google a single brand entity to attach VoiceForge queries
 * to, and `WebSite` references it by `@id` so page-level nodes (Product,
 * FAQPage, BreadcrumbList) all resolve to the same publisher instead of looking
 * like unrelated documents.
 *
 * Deliberately omitted: `aggregateRating`, `review`, employee counts, and
 * funding. There are no public customers or reviews yet, and inventing them
 * would be both false and a structured-data penalty risk.
 */
const ORGANIZATION_ID = `${siteUrl}/#organization`;

export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORGANIZATION_ID,
    name: 'VoiceForge AI',
    url: siteUrl,
    logo: `${siteUrl}/logo.svg`,
    description:
      'VoiceForge AI is a spec-first platform for building, testing, governing, deploying, and white-labeling AI voice calling agents.',
    sameAs: ['https://github.com/Deepak8858/voice-agent-builder'],
  };
}

export function webSiteJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${siteUrl}/#website`,
    name: 'VoiceForge AI',
    url: siteUrl,
    publisher: { '@id': ORGANIZATION_ID },
  };
}
