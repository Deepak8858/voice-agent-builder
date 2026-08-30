import type { NextRequest } from 'next/server';
import { siteUrl } from '@/lib/site-url';

/**
 * Path prefixes the browser proxy is allowed to forward to the API.
 *
 * The proxy attaches the internal API key to every request it forwards, so
 * without this list any signed-in user could reach any API path — including
 * internal-only surfaces such as `admin/retention` — simply by typing the URL.
 * Prefixes (not exact paths) are used so new routes under an already-exposed
 * resource keep working, while anything not deliberately exposed to the
 * browser stays unreachable.
 *
 * A prefix matches whole segments only (`/workspaces` matches `/workspaces/x`
 * but not `/workspacesx`), so a prefix can never be widened by a lookalike
 * first segment, and paths containing a `.`/`..` segment or a backslash are
 * refused outright so an allowed prefix cannot be walked out of.
 *
 * The retention page used to need its own `/v1/workspaces/me/retention` entry
 * because SettingsController doubled the global `api/v1` prefix. That prefix is
 * gone (CS-40), so the route now sits under the existing `/workspaces` prefix
 * and no `/v1` entry exists at all — the erasure endpoints still mounted under
 * the doubled namespace stay unreachable from the browser, as before.
 *
 * proxy-guards.test.ts extracts every proxy call site in apps/web and asserts
 * both directions: every requested path matches a prefix here, and every
 * prefix here still has at least one caller. Adding an entry without a caller
 * (or a caller without an entry) fails that test.
 */
export const ALLOWED_PROXY_PREFIXES = [
  '/auth/me',
  '/workspaces',
  '/templates',
  '/invites/accept',
  '/agents/generate',
] as const;

/**
 * A segment the URL parser resolves away. `%2e` counts as a dot: verified that
 * `new URL('http://x/api/v1/a/%2e%2e/b').pathname` is `/api/v1/b`. Next.js
 * percent-decodes the catch-all param once, so `%2e%2e` in the request arrives
 * here as `..` and `%252e%252e` arrives as `%2e%2e` — both spellings have to be
 * caught, which is why this checks the decoded form rather than `=== '..'`.
 */
function isDotSegment(segment: string): boolean {
  const decoded = segment.replace(/%2e/gi, '.');
  return decoded === '.' || decoded === '..';
}

export function isAllowedProxyPath(pathString: string): boolean {
  // A backslash is a path separator to the WHATWG URL parser on http(s) URLs
  // but not to the split('/') below: verified that
  // `new URL('http://x/api/v1/workspaces/..\\admin/y').pathname` is
  // `/api/v1/admin/y`. Next.js percent-decodes the catch-all param, so a
  // request for `/workspaces/..%5Cadmin/y` arrives here as that string, where
  // `..\admin` is not a dot segment and `/workspaces` still matches a prefix.
  // No path the browser legitimately proxies contains a backslash, so the
  // character is refused outright rather than modelling how the parser folds it.
  if (pathString.includes('\\')) return false;
  // Traversal is rejected BEFORE the prefix test, because the prefix test reads
  // the raw joined segments while route.ts interpolates that same string into
  // the upstream URL, where the parser resolves `..` away. Without this,
  // `/workspaces/../admin/retention/sweep` matched the `/workspaces` prefix
  // here and reached `/api/v1/admin/retention/sweep` upstream — with the
  // internal key attached. Dropping dot segments is what makes the path this
  // function checks and the path the API receives the same path.
  if (pathString.split('/').some(isDotSegment)) return false;
  return ALLOWED_PROXY_PREFIXES.some(
    (prefix) => pathString === prefix || pathString.startsWith(`${prefix}/`),
  );
}

/**
 * Same-origin check for mutating proxy requests (CSRF defense in depth).
 *
 * A cross-site page can make the browser POST here with the session cookies
 * attached; the Origin header is the one thing that page cannot forge. The
 * Origin's host is compared against the hosts this deployment answers as:
 * the client-nearest `X-Forwarded-Host` (set by nginx, same trust rationale
 * as public-origin.ts), the raw `Host`, and the canonical `siteUrl`. Hosts
 * are compared instead of full origins because the scheme the browser saw is
 * not reliably knowable behind the proxy.
 *
 * An absent Origin is allowed on purpose: non-browser clients and some
 * legacy same-origin requests omit it, and they still have to present a
 * valid session cookie. GET is exempt at the call sites because EventSource
 * sends no Origin and the SSE pass-through must keep working.
 */
export function isTrustedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Covers the literal "null" Origin sent by sandboxed/opaque contexts.
    return false;
  }

  const ownHosts = [
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
    req.headers.get('host'),
    new URL(siteUrl).host,
  ];
  return ownHosts.includes(originHost);
}
