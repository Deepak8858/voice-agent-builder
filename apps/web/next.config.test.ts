import { afterEach, describe, expect, it } from 'vitest';
import nextConfig from './next.config';
import { buildContentSecurityPolicy } from './lib/content-security-policy';
import { POSTHOG_PROXY_PREFIX } from './lib/analytics/posthog-config';

const TEST_NONCE = 'dGVzdC1ub25jZQ==';

async function headerMap(): Promise<Map<string, string>> {
  if (typeof nextConfig.headers !== 'function') {
    throw new Error('next.config.ts must export a headers() function');
  }
  const groups = await nextConfig.headers();
  return new Map(
    groups.flatMap((group) => group.headers).map((h) => [h.key, h.value] as [string, string]),
  );
}

/**
 * The CSP is built per-request in middleware.ts so each response can carry a
 * fresh nonce; it is deliberately NOT a static header in next.config.ts.
 * Assert against the builder that middleware actually uses.
 */
function cspDirectives(): Map<string, string[]> {
  const csp = buildContentSecurityPolicy(TEST_NONCE);

  return new Map(
    csp.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

describe('next.config security headers', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  it('emits a strict baseline CSP', () => {
    const directives = cspDirectives();

    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('binds scripts to a per-request nonce and forbids inline event handlers', () => {
    const directives = cspDirectives();

    expect(directives.get('script-src')).toContain(`'nonce-${TEST_NONCE}'`);
    expect(directives.get('script-src')).toContain("'strict-dynamic'");
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
    expect(directives.get('script-src-attr')).toEqual(["'none'"]);
  });

  it('allows no wildcard sources in any CSP directive', () => {
    const directives = cspDirectives();

    for (const [name, values] of directives) {
      expect(values, `${name} must not allow *`).not.toContain('*');
      expect(values, `${name} must not allow any https: origin`).not.toContain('https:');
      expect(values, `${name} must not allow any http: origin`).not.toContain('http:');
    }
  });

  it('only frames trusted checkout and Supabase origins', () => {
    const directives = cspDirectives();

    expect(directives.get('frame-src')).toEqual([
      "'self'",
      'https://checkout.dodopayments.com',
      'https://*.supabase.co',
      'https://*.supabase.com',
    ]);
  });

  it('connects only to self, the configured API, Supabase, and GA beacons', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.voiceforge.example';
    const directives = cspDirectives();

    // No payment-provider origin: hosted Checkout and the customer portal are
    // top-level redirects, so the browser never calls Dodo Payments directly.
    // Google Analytics is the one third party gtag cannot reach through a
    // same-origin proxy, so its documented beacon hosts are named explicitly.
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      'https://api.voiceforge.example',
      'https://*.supabase.co',
      'https://*.supabase.com',
      'https://*.google-analytics.com',
      'https://*.analytics.google.com',
      'https://*.googletagmanager.com',
    ]);
  });

  it('allows the gtag loader host for CSP2 browsers', () => {
    const directives = cspDirectives();

    expect(directives.get('script-src')).toContain('https://*.googletagmanager.com');
    expect(directives.get('img-src')).toContain('https://*.google-analytics.com');
  });

  it('proxies PostHog through the same origin instead of widening connect-src', () => {
    const directives = cspDirectives();

    for (const [name, values] of directives) {
      for (const value of values) {
        expect(value, `${name} must not name a PostHog origin directly`).not.toContain('posthog.com');
      }
    }
    expect(directives.get('connect-src')).toContain("'self'");
    // The replay compression worker is a blob worker served from this origin.
    expect(directives.get('worker-src')).toContain("'self'");
    expect(directives.get('worker-src')).toContain('blob:');
    // Lazily-loaded SDK bundles arrive through the proxy under 'self'.
    expect(directives.get('script-src')).toContain("'self'");
  });

  it('sets hardening headers on every route', async () => {
    const headers = await headerMap();

    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=()',
    );
  });
});

describe('next.config PostHog proxy', () => {
  async function beforeFilesRewrites() {
    if (typeof nextConfig.rewrites !== 'function') {
      throw new Error('next.config.ts must export a rewrites() function');
    }
    const rewrites = await nextConfig.rewrites();
    if (Array.isArray(rewrites) || !rewrites.beforeFiles) {
      throw new Error('rewrites() must return phased rewrites so beforeFiles ordering is explicit');
    }
    return rewrites.beforeFiles;
  }

  it('registers the proxy in beforeFiles so no app route can shadow it', async () => {
    const rewrites = await beforeFilesRewrites();

    expect(rewrites.length).toBeGreaterThan(0);
    for (const rewrite of rewrites) {
      expect(rewrite.source.startsWith(`${POSTHOG_PROXY_PREFIX}/`)).toBe(true);
    }
  });

  it('matches asset and remote-config routes before the ingestion catch-all', async () => {
    const sources = (await beforeFilesRewrites()).map((r) => r.source);
    const catchAll = sources.indexOf(`${POSTHOG_PROXY_PREFIX}/:path*`);

    expect(catchAll).toBeGreaterThan(-1);
    expect(sources.indexOf(`${POSTHOG_PROXY_PREFIX}/static/:path*`)).toBeLessThan(catchAll);
    expect(sources.indexOf(`${POSTHOG_PROXY_PREFIX}/array/:path*`)).toBeLessThan(catchAll);
    expect(catchAll).toBe(sources.length - 1);
  });

  it('routes only to the supported PostHog ingestion and asset hosts', async () => {
    for (const { destination } of await beforeFilesRewrites()) {
      const hostname = new URL(destination.replace('/:path*', '/')).hostname;
      expect([
        'us.i.posthog.com',
        'eu.i.posthog.com',
        'us-assets.i.posthog.com',
        'eu-assets.i.posthog.com',
      ]).toContain(hostname);
    }
  });

  it('does not redirect trailing slashes, which PostHog ingestion paths use', () => {
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);
  });
});
