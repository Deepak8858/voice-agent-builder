import { describe, expect, it } from 'vitest';
import { organizationJsonLd, webSiteJsonLd } from './site-structured-data';
import { siteUrl } from '@/lib/site-url';

/**
 * Site-level entity markup.
 *
 * `Organization` and `WebSite` are how Google resolves "VoiceForge AI" to a
 * single brand entity across pages. Neither existed before, so brand queries had
 * no entity to attach to. These live in the root layout and therefore appear on
 * every page.
 */
describe('organizationJsonLd', () => {
  const data = organizationJsonLd();

  it('describes the brand on the canonical origin', () => {
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('Organization');
    expect(data.name).toBe('VoiceForge AI');
    expect(data.url).toBe(siteUrl);
  });

  it('uses an absolute logo URL', () => {
    expect(String(data.logo)).toMatch(/^https?:\/\//);
  });

  it('declares a stable @id so other nodes can reference the same entity', () => {
    expect(data['@id']).toBe(`${siteUrl}/#organization`);
  });

  it('claims no fabricated ratings, review counts, or customer figures', () => {
    // Inventing aggregateRating without real reviews is both false and a
    // structured-data penalty risk. VoiceForge has no public customers yet.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('aggregateRating');
    expect(serialized).not.toContain('reviewCount');
    expect(serialized).not.toContain('ratingValue');
  });
});

describe('webSiteJsonLd', () => {
  const data = webSiteJsonLd();

  it('describes the site and links it to the organization entity', () => {
    expect(data['@type']).toBe('WebSite');
    expect(data.url).toBe(siteUrl);
    expect(data.publisher).toStrictEqual({ '@id': `${siteUrl}/#organization` });
  });
});
