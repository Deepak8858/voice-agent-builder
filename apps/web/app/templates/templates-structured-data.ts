import { templateContent } from '@/lib/template-content';
import { siteUrl } from '@/lib/site-url';

/**
 * `ItemList` markup for the `/templates` hub.
 *
 * Generated from `templateContent` — the same source the page body renders — so
 * a newly shipped template appears in the structured data automatically rather
 * than requiring a parallel hand-maintained list to be updated.
 */
export function templateListJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'AI voice agent templates',
    description:
      'Vertical voice-agent templates for reception, dental clinics, real estate lead qualification, appointment reminders, and order confirmation.',
    itemListElement: templateContent.map((template, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: template.name,
      url: `${siteUrl}/templates/${template.slug}`,
    })),
  };
}
