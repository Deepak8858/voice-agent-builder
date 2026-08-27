import { describe, expect, it } from 'vitest';
import { templateContent } from '@/lib/template-content';
import { templateListJsonLd } from './templates-structured-data';
import { siteUrl } from '@/lib/site-url';

/**
 * `/templates` is the hub for the highest-intent vertical pages (Cluster B), but
 * it shipped with no structured data at all, so Google had no machine-readable
 * signal that it indexes a set of child pages. `ItemList` states that
 * relationship explicitly and is generated from the same source the page
 * renders, so a new template cannot be added without appearing here.
 */
describe('templateListJsonLd', () => {
  const data = templateListJsonLd();

  it('is an ItemList node', () => {
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('ItemList');
  });

  it('lists every rendered template exactly once, in order', () => {
    const items = data.itemListElement as Record<string, unknown>[];

    expect(items).toHaveLength(templateContent.length);
    expect(items.length).toBeGreaterThan(0);

    items.forEach((item, index) => {
      expect(item['@type']).toBe('ListItem');
      expect(item.position).toBe(index + 1);
      expect(item.name).toBe(templateContent[index].name);
      expect(item.url).toBe(`${siteUrl}/templates/${templateContent[index].slug}`);
    });
  });

  it('uses absolute URLs so the list resolves off-site', () => {
    const items = data.itemListElement as Record<string, unknown>[];
    for (const item of items) {
      expect(String(item.url).startsWith(`${siteUrl}/templates/`)).toBe(true);
    }
  });
});
