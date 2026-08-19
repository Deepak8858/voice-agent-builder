import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site-url';

/**
 * Public, indexable routes only.
 *
 * Deliberately static: every other page in the app is behind authentication, so
 * there is nothing to enumerate from the database. Listing authenticated routes
 * here would contradict `robots.ts` and waste crawl budget on sign-in redirects.
 */
const publicRoutes = [
  { path: '/', changeFrequency: 'weekly', priority: 1 },
  { path: '/pricing', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/services', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/sign-up', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/support', changeFrequency: 'monthly', priority: 0.4 },
  { path: '/sign-in', changeFrequency: 'monthly', priority: 0.3 },
  { path: '/refund', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/privacypolicy', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/legal/dpa', changeFrequency: 'yearly', priority: 0.2 },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return publicRoutes.map((route) => ({
    url: `${siteUrl}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
