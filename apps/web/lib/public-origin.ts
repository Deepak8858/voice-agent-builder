import type { NextRequest } from 'next/server';
import { siteUrl } from '@/lib/site-url';
import { safeRedirectPath } from '@/lib/safe-redirect';

/**
 * Absolute URL for a same-app redirect issued from a route handler.
 *
 * Route handlers must NOT build redirects from `req.url`: in the standalone
 * production server that URL reflects the container's internal bind address
 * (e.g. `https://0.0.0.0:3000`), so the browser gets bounced to an
 * unreachable host after OAuth callbacks. The origin is therefore always the
 * canonical `NEXT_PUBLIC_APP_URL` (via `siteUrl`), which the deploy workflow
 * hard-requires and bakes into the image as a Docker build arg.
 *
 * `X-Forwarded-Host` is deliberately NOT consulted (A-014). It only ever
 * equalled the public origin because nginx overwrites it with `$host`; the
 * branch that trusted it validated only that the result *parsed*, so on any
 * request reaching the app without that proxy in front (infra/nginx/http.conf,
 * the pre-certificate first-boot mode, passes a client-supplied value straight
 * through) it fed an attacker-chosen host into a response `Location` — an
 * unkeyed-input cache-poisoning primitive rather than a click-through open
 * redirect, since a browser cannot add that header itself.
 *
 * It is deleted rather than allow-listed because there is exactly one public
 * origin to resolve to: nginx serves `incfrog.ai` alone, and white-label
 * brands are path-based (`app/a/[slug]`) — `white_label_settings.custom_domain`
 * is stored but never served. With one valid host, an allow-list check is
 * equivalent to just using `siteUrl`, so this branch was dead weight.
 *
 * `path` is run through `safeRedirectPath` because `new URL(path, base)`
 * lets an absolute or protocol-relative `path` replace the base entirely.
 * Validating here rather than at each call site means a future caller cannot
 * reopen the redirect by forgetting to sanitise its own input.
 *
 * `req` is unused but kept in the signature so call sites keep passing the
 * request instead of drifting back to building redirects from `req.url`.
 */
export function publicRedirectUrl(path: string, _req: NextRequest): URL {
  return new URL(safeRedirectPath(path), siteUrl);
}
