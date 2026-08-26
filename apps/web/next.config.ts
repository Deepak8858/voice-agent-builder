import type { NextConfig } from "next";
import {
  assetHostFor,
  posthogProxyRewrites,
  resolvePostHogHost,
} from "./lib/analytics/posthog-config";

/**
 * Ingestion host for the proxy destinations.
 *
 * Resolved through the same normalizer the browser SDK uses, so the rewrite
 * destination and the SDK's notion of the host can never disagree — a drift
 * there would silently 404 every capture.
 *
 * Read from the environment rather than through `posthogWebSettingsFromEnv` on
 * purpose: the rewrites are static build-time config and must exist even when
 * the analytics kill switch is off, so that turning PostHog on is a runtime
 * change and not a rebuild. The rewrites are inert while the browser SDK is
 * never initialised.
 *
 * Strict for any production build (`next build` sets NODE_ENV=production,
 * including in CI): a malformed host fails the build rather than shipping a
 * proxy silently pointed at the default region. Only `next dev` stays
 * non-strict and falls back. An absent value is always fine — it resolves to
 * the default region.
 */
const posthogHost = resolvePostHogHost(process.env.NEXT_PUBLIC_POSTHOG_HOST, {
  strict: process.env.NODE_ENV === "production",
  envVar: "NEXT_PUBLIC_POSTHOG_HOST",
});

const nextConfig: NextConfig = {
  output: "standalone",
  /**
   * PostHog appends a trailing slash to some ingestion paths; without this,
   * Next.js answers with a 308 redirect that the SDK does not follow, and
   * capture silently fails.
   */
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return {
      /**
       * `beforeFiles` so the proxy cannot be shadowed by a page, a static file
       * or a same-named app route. `posthogProxyRewrites` returns the `/static/`
       * and `/array/` asset rules ahead of the ingestion catch-all, and that
       * order is load-bearing.
       */
      beforeFiles: posthogProxyRewrites({
        host: posthogHost,
        assetHost: assetHostFor(posthogHost),
      }),
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {

    /**
     * Long-lived caching for assets served out of `public/`.
     *
     * Next.js defaults these to `public, max-age=0`, which forces a
     * revalidation round trip on every view. The hero image is the landing
     * page's LCP element, so that default directly cost the largest paint.
     *
     * Unlike `/_next/static`, these filenames are not content-hashed, so this
     * is not `immutable`: a week balances load time against the cost of a
     * stale asset. Replacing one of these files requires a new name (or a
     * query string) to invalidate caches before then.
     *
     * Set here rather than in nginx on purpose — an nginx `location` block with
     * its own `add_header` stops inheriting the server-level security headers,
     * which would strip HSTS and friends from these responses.
     */
    const publicAssetCache = [
      { key: "Cache-Control", value: "public, max-age=604800" },
    ];

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
        ],
      },
      { source: "/images/:path*", headers: publicAssetCache },
      { source: "/demo/:path*", headers: publicAssetCache },
    ];
  },
};

export default nextConfig;
