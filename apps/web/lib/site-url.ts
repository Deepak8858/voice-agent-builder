/**
 * Canonical absolute origin for this deployment.
 *
 * Single source for `metadataBase`, `robots.txt` and `sitemap.xml`. If these
 * three disagree, search engines silently drop the sitemap (it must be served
 * from the same host it declares), so they are deliberately derived from one
 * value rather than repeated.
 *
 * `NEXT_PUBLIC_APP_URL` is already injected as a Docker build arg by the deploy
 * workflow, so no new configuration is required. Any trailing slash is stripped
 * because every consumer concatenates a path onto this value.
 */
const rawSiteUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export const siteUrl = rawSiteUrl.replace(/\/+$/, '');
