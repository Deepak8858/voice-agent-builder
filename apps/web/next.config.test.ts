import { afterEach, describe, expect, it } from 'vitest';
import nextConfig from './next.config';
import { buildContentSecurityPolicy } from './lib/content-security-policy';

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
      'https://checkout.stripe.com',
      'https://*.supabase.co',
      'https://*.supabase.com',
    ]);
  });

  it('connects only to self, the configured API, Supabase, and Stripe', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.voiceforge.example';
    const directives = cspDirectives();

    expect(directives.get('connect-src')).toEqual([
      "'self'",
      'https://api.voiceforge.example',
      'https://*.supabase.co',
      'https://*.supabase.com',
      'https://api.stripe.com',
    ]);
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
