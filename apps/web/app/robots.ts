import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site-url';

/**
 * Crawl directives.
 *
 * Authenticated and transactional surfaces are disallowed rather than left to
 * chance: they require a session, so crawling them only burns crawl budget on
 * redirects to `/sign-in`. `/api/` is excluded for the same reason. The public
 * agent share pages under `/a/` stay crawlable — they are the marketing surface.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/dashboard', '/dashboard/', '/checkout/', '/auth/', '/onboarding', '/invite'],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
