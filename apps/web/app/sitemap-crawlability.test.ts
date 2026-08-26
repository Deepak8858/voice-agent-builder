import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import sitemap from './sitemap';
import robots from './robots';
import { updateSupabaseSession } from '../middleware-utils';
import { siteUrl } from '@/lib/site-url';

/**
 * Indexation contract.
 *
 * A URL advertised in `sitemap.xml` is a promise to a crawler that the URL
 * returns content. Two independent lists can break that promise:
 *
 *  1. `middleware-utils.ts` — a marketing route whose path collides with a
 *     `PROTECTED_PREFIXES` entry is answered with a 307 to `/sign-in`. Googlebot
 *     is always unauthenticated, so such a page can never be indexed. This
 *     regressed live: `/compliance` and `/integrations` were in the sitemap and
 *     in `PROTECTED_PREFIXES`, so both were uncrawlable.
 *  2. `robots.ts` — a `disallow` rule covering a sitemap URL is a direct
 *     contradiction and suppresses the page.
 *
 * These suites read the real sitemap so any newly added marketing route is
 * checked automatically instead of relying on the author remembering.
 */

function sitemapPaths(): string[] {
  return sitemap().map((entry) => new URL(entry.url).pathname);
}

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

describe('sitemap indexability', () => {
  it('lists at least the known marketing surface', () => {
    const paths = sitemapPaths();
    expect(paths).toContain('/');
    expect(paths).toContain('/compliance');
    expect(paths).toContain('/integrations');
    expect(paths.length).toBeGreaterThan(20);
  });

  it('serves every sitemap URL to an unauthenticated crawler without redirecting', async () => {
    const redirected: { path: string; location: string | null }[] = [];

    for (const path of sitemapPaths()) {
      const res = await updateSupabaseSession(request(path));
      const location = res.headers.get('location');
      if (location !== null) redirected.push({ path, location });
    }

    // Every sitemap URL must be reachable without a session. A non-empty list
    // means those pages are advertised to Google but answer with a sign-in
    // redirect, so they cannot rank.
    expect(redirected).toStrictEqual([]);
  });

  it('does not advertise any URL that robots.txt disallows', () => {
    const rules = robots().rules;
    const ruleList = Array.isArray(rules) ? rules : [rules];
    const disallowed = ruleList
      .flatMap((rule) => (Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow]))
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    const contradictions = sitemapPaths().filter((path) =>
      disallowed.some((rule) =>
        rule.endsWith('/') ? path.startsWith(rule) : path === rule || path.startsWith(`${rule}/`),
      ),
    );

    expect(contradictions).toStrictEqual([]);
  });

  it('emits absolute URLs on the canonical origin', () => {
    for (const entry of sitemap()) {
      expect(entry.url.startsWith(siteUrl)).toBe(true);
    }
  });

  it('contains no duplicate URLs', () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls.length).toBe(new Set(urls).size);
  });
});
