import type { NextRequest } from 'next/server';
import { siteUrl } from '@/lib/site-url';

/**
 * Absolute URL for a same-app redirect issued from a route handler.
 *
 * Route handlers must NOT build redirects from `req.url`: in the standalone
 * production server that URL reflects the container's internal bind address
 * (e.g. `https://0.0.0.0:3000`), so the browser gets bounced to an
 * unreachable host after OAuth callbacks. Instead the public origin is
 * resolved, in order, from:
 *
 * 1. `X-Forwarded-Host` + `X-Forwarded-Proto` — set by the nginx proxy in
 *    front of the app (infra/nginx/https.conf.template), so this is correct
 *    for every proxied production request.
 * 2. `NEXT_PUBLIC_APP_URL` via `siteUrl` — the canonical deployment origin
 *    baked in at build time; covers requests that somehow bypass the proxy.
 *
 * Only the first (client-nearest) value of a comma-separated forwarded
 * header is used. The host value is validated with the URL parser so a
 * malformed or header-injected value falls through to the canonical origin
 * instead of poisoning the redirect.
 */
export function publicRedirectUrl(path: string, req: NextRequest): URL {
  const forwardedHost = firstForwardedValue(req.headers.get('x-forwarded-host'));
  const forwardedProto = firstForwardedValue(req.headers.get('x-forwarded-proto'));

  if (forwardedHost) {
    const proto = forwardedProto === 'http' ? 'http' : 'https';
    try {
      return new URL(path, `${proto}://${forwardedHost}`);
    } catch {
      // Malformed forwarded host — fall through to the canonical origin.
    }
  }

  return new URL(path, siteUrl);
}

function firstForwardedValue(headerValue: string | null): string | null {
  const first = headerValue?.split(',')[0]?.trim();
  return first ? first : null;
}
