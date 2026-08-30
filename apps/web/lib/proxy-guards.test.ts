import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextRequest } from 'next/server';
import { ALLOWED_PROXY_PREFIXES, isAllowedProxyPath, isTrustedOrigin } from './proxy-guards';

describe('isAllowedProxyPath', () => {
  it('allows the deliberately exposed prefixes', () => {
    expect(isAllowedProxyPath('/auth/me')).toBe(true);
    expect(isAllowedProxyPath('/workspaces/ws1/agents/a1/publish')).toBe(true);
    expect(isAllowedProxyPath('/templates')).toBe(true);
    expect(isAllowedProxyPath('/templates/receptionist')).toBe(true);
    expect(isAllowedProxyPath('/invites/accept')).toBe(true);
    expect(isAllowedProxyPath('/agents/generate')).toBe(true);
    expect(isAllowedProxyPath('/agents/generate/a1')).toBe(true);
    // CS-40: the retention route lost its doubled `v1/` prefix, so it is covered
    // by the plain `/workspaces` prefix and the old spelling is now refused.
    expect(isAllowedProxyPath('/workspaces/me/retention')).toBe(true);
    // Same wave, and a real reachability change rather than a rename: contact
    // erasure moved out of the doubled namespace into `/workspaces`, so the
    // browser can now reach it. Intended — it is scoped to the session
    // workspace — but pinned so the change is a reviewed diff if it reverses.
    expect(isAllowedProxyPath('/workspaces/me/contacts/c1/erasure')).toBe(true);
  });

  it('rejects internal-only API surfaces', () => {
    expect(isAllowedProxyPath('/admin/retention')).toBe(false);
    expect(isAllowedProxyPath('/internal/anything')).toBe(false);
    // Nothing under the doubled-v1 namespace is proxied: only
    // `GET v1/orgs/:orgId/audit-logs` still mounts there, and the retention and
    // erasure routes no longer do, so their old spellings are refused too.
    expect(isAllowedProxyPath('/v1/orgs/o1/audit-logs')).toBe(false);
    expect(isAllowedProxyPath('/v1/workspaces/me/retention')).toBe(false);
    expect(isAllowedProxyPath('/v1/users/me/erasure')).toBe(false);
    // The API serves this at its new path; the browser is not given `/users`.
    expect(isAllowedProxyPath('/users/me/erasure')).toBe(false);
  });

  it('matches whole segments, not raw string prefixes', () => {
    expect(isAllowedProxyPath('/workspacesx/ws1')).toBe(false);
    expect(isAllowedProxyPath('/templatesfoo')).toBe(false);
    expect(isAllowedProxyPath('/workspaces')).toBe(true);
  });

  /**
   * The allow-list runs on the joined catch-all segments, but route.ts puts
   * that same string into the upstream URL where the parser resolves dot
   * segments away — so a path can match an allowed prefix here and arrive
   * somewhere else entirely, carrying the internal key. Each input below is
   * the string Next.js actually produces (it decodes the param once):
   * `%2e%2e` in the request URL becomes `..`, and `%252e%252e` becomes the
   * literal `%2e%2e`, which `new URL` still collapses.
   */
  it.each([
    ['/workspaces/../admin/retention/sweep', '/api/v1/admin/retention/sweep'],
    ['/workspaces/%2e%2e/admin/retention/sweep', '/api/v1/admin/retention/sweep'],
    ['/workspaces/%2E%2E/users/me/erasure', '/api/v1/users/me/erasure'],
    ['/workspaces/a/../../metrics', '/api/v1/metrics'],
    ['/templates/./../admin/retention/sweep', '/api/v1/admin/retention/sweep'],
  ])('rejects %s, which the upstream URL resolves to %s', (path, upstream) => {
    // Pins the premise as well as the fix: if URL parsing ever stopped
    // collapsing these, the second assertion would fail and say so.
    expect(new URL(`http://api.internal/api/v1${path}`).pathname).toBe(upstream);
    expect(isAllowedProxyPath(path)).toBe(false);
  });

  /**
   * Same escape as the dot-segment cases, through a separator `split('/')`
   * cannot see: the URL parser treats `\` as `/` on http(s) URLs. Next.js
   * decodes the catch-all param, so a request for `/workspaces/..%5Cadmin/...`
   * arrives here with a literal backslash. Written with String.fromCharCode so
   * the escaping is unambiguous.
   */
  const BS = String.fromCharCode(92);
  it.each([
    [`/workspaces/..${BS}admin/retention/sweep`, '/api/v1/admin/retention/sweep'],
    [`/workspaces/%2e%2e${BS}users/me/erasure`, '/api/v1/users/me/erasure'],
    [`/templates/..${BS}..${BS}metrics`, '/api/metrics'],
  ])('rejects backslash path %s, which resolves to %s', (path, upstream) => {
    expect(new URL(`http://api.internal/api/v1${path}`).pathname).toBe(upstream);
    expect(isAllowedProxyPath(path)).toBe(false);
  });

  it('rejects a bare backslash even where it resolves inside the prefix', () => {
    // `/api/v1/workspaces//admin/...` is not an escape, but a backslash has no
    // legitimate use here and an empty segment is not something to forward.
    expect(isAllowedProxyPath(`/workspaces/${BS}admin/retention/sweep`)).toBe(false);
  });

  it('leaves an encoded %2F alone (the URL parser does not fold it)', () => {
    // Documents why only `\` needs the extra guard: `%2f` survives URL
    // parsing, so it reaches the API as an opaque id segment, not a separator.
    expect(new URL('http://api.internal/api/v1/workspaces/a/..%2fadmin').pathname).toBe(
      '/api/v1/workspaces/a/..%2fadmin',
    );
  });

  it('still allows dots inside a segment', () => {
    // Only a segment that is entirely dots is traversal; an id or filename
    // containing one is ordinary.
    expect(isAllowedProxyPath('/workspaces/ws1/knowledge/notes.pdf')).toBe(true);
    expect(isAllowedProxyPath('/templates/v1.2')).toBe(true);
  });
});

function fakeRequest(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe('isTrustedOrigin', () => {
  it('allows requests without an Origin header (non-browser clients)', () => {
    expect(isTrustedOrigin(fakeRequest({}))).toBe(true);
  });

  it('allows an Origin matching the Host header', () => {
    expect(
      isTrustedOrigin(fakeRequest({ origin: 'http://localhost:3000', host: 'localhost:3000' })),
    ).toBe(true);
  });

  it('allows an Origin matching the client-nearest X-Forwarded-Host', () => {
    expect(
      isTrustedOrigin(
        fakeRequest({
          origin: 'https://incfrog.ai',
          host: 'web:3000',
          'x-forwarded-host': 'incfrog.ai, internal-lb.local',
        }),
      ),
    ).toBe(true);
  });

  it('rejects a cross-site Origin', () => {
    expect(
      isTrustedOrigin(fakeRequest({ origin: 'https://evil.example', host: 'incfrog.ai' })),
    ).toBe(false);
  });

  it('rejects the opaque "null" Origin', () => {
    expect(isTrustedOrigin(fakeRequest({ origin: 'null', host: 'incfrog.ai' }))).toBe(false);
  });
});

/**
 * Self-maintaining allow-list check.
 *
 * (a) Every literal path the web app sends through the proxy — via
 *     useApi().call(...) or a direct '/api/proxy/...' URL — must match an
 *     allow-list prefix, so adding a new call site to a path the proxy
 *     blocks fails here instead of 404ing in the browser.
 * (b) Every allow-list prefix must still have at least one caller, so the
 *     list cannot quietly accumulate dead entries and rot into a wildcard.
 *
 * ponytail: literal extraction only — a path built in a variable and passed
 * by name (e.g. knowledge-panel's listUrl) is invisible to (a). Upgrade to a
 * TS-AST walk if variable-passed proxy paths become common.
 */
describe('proxy allow-list stays in sync with call sites', () => {
  const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  const SCAN_ROOTS = ['app', 'components', 'lib'];

  // First argument of call(...) / call<T>(...) when it is a '/...' literal.
  // The generic part must not cross a paren, so a non-literal call site can
  // never make the lazy match skip ahead to an unrelated string.
  const CALL_SITE = /\bcall(?:<[^()]*>)?\(\s*(?:'(\/[^']*)'|`(\/[^`]*)`)/g;
  // Direct proxy URLs (EventSource for SSE).
  const DIRECT_URL = /['"`]\/api\/proxy(\/[^'"`]+)/g;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : sourceFiles(full);
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
      return [full];
    });
  }

  function normalize(literal: string): string {
    // Query strings never reach the allow-list check (the proxy appends
    // req.nextUrl.search separately) and dynamic segments are opaque ids.
    return literal.split('?')[0].replace(/\$\{[^}]*\}/g, 'x');
  }

  const callSites: Array<{ file: string; path: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(WEB_ROOT, root))) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(CALL_SITE)) {
        callSites.push({
          file: relative(WEB_ROOT, file),
          path: normalize(match[1] ?? match[2] ?? ''),
        });
      }
      for (const match of content.matchAll(DIRECT_URL)) {
        callSites.push({ file: relative(WEB_ROOT, file), path: normalize(match[1]) });
      }
    }
  }

  it('finds the call sites at all (extraction regex still works)', () => {
    // Well below the real count (~90); fails only if extraction breaks
    // wholesale, which would otherwise make (a) pass vacuously.
    expect(callSites.length).toBeGreaterThan(30);
  });

  it('(a) every proxy call site targets an allow-listed path', () => {
    const violations = callSites.filter(({ path }) => !isAllowedProxyPath(path));
    expect(violations).toEqual([]);
  });

  it('(b) every allow-list prefix has at least one caller', () => {
    const dead = ALLOWED_PROXY_PREFIXES.filter(
      (prefix) =>
        !callSites.some(({ path }) => path === prefix || path.startsWith(`${prefix}/`)),
    );
    expect(dead).toEqual([]);
  });
});
