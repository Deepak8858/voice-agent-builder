import { afterEach, describe, expect, it } from 'vitest';
import nextConfig from './next.config';

async function headerMap(): Promise<Map<string, string>> {
  if (typeof nextConfig.headers !== 'function') {
    throw new Error('next.config.ts must export a headers() function');
  }
  const groups = await nextConfig.headers();
  return new Map(
    groups.flatMap((group) => group.headers).map((h) => [h.key, h.value] as [string, string]),
  );
}

async function cspDirectives(): Promise<Map<string, string[]>> {
  const headers = await headerMap();
  const csp = headers.get('Content-Security-Policy');
  if (!csp) throw new Error('Content-Security-Policy header is missing');

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

  it('emits a strict baseline CSP', async () => {
    const directives = await cspDirectives();

    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
  });

  it('allows no wildcard sources in any CSP directive', async () => {
    const directives = await cspDirectives();

    for (const [name, values] of directives) {
      expect(values, `${name} must not allow *`).not.toContain('*');
      expect(values, `${name} must not allow any https: origin`).not.toContain('https:');
      expect(values, `${name} must not allow any http: origin`).not.toContain('http:');
    }
  });

  it('only frames trusted checkout and Supabase origins', async () => {
    const directives = await cspDirectives();

    expect(directives.get('frame-src')).toEqual([
      "'self'",
      'https://checkout.stripe.com',
      'https://*.supabase.co',
      'https://*.supabase.com',
    ]);
  });

  it('connects only to self, the configured API, Supabase, and Stripe', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.voiceforge.example';
    const directives = await cspDirectives();

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
