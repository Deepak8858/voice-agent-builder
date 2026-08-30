import { describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { publicRedirectUrl } from './public-origin';
import { siteUrl } from './site-url';

function fakeRequest(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

const canonical = new URL(siteUrl);

describe('publicRedirectUrl', () => {
  it('uses the canonical site origin, never the request URL', () => {
    // The request URL (container bind address, https://0.0.0.0:3000) must
    // never leak into the redirect.
    const url = publicRedirectUrl('/dashboard/settings/google', fakeRequest({}));
    expect(url.origin).toBe(canonical.origin);
    expect(url.pathname).toBe('/dashboard/settings/google');
  });

  // A-014: X-Forwarded-Host used to pick the redirect origin, validated only
  // for parseability. nginx overwrites it in the steady-state HTTPS path, so
  // this was never a click-through open redirect, but any deployment reaching
  // the app without that proxy fed an attacker-chosen host into a `Location`.
  // There is one public origin, so the header is now ignored outright.
  it('ignores X-Forwarded-Host so a forged host cannot steer the redirect', () => {
    const url = publicRedirectUrl(
      '/dashboard',
      fakeRequest({ 'x-forwarded-host': 'attacker.example' }),
    );
    expect(url.host).toBe(canonical.host);
    expect(url.toString()).not.toContain('attacker.example');
  });

  it('ignores X-Forwarded-Proto', () => {
    const url = publicRedirectUrl(
      '/sign-in',
      fakeRequest({ 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' }),
    );
    expect(url.origin).toBe(canonical.origin);
  });

  it('ignores a comma-separated forwarded host list', () => {
    const url = publicRedirectUrl(
      '/dashboard',
      fakeRequest({
        'x-forwarded-host': 'attacker.example, internal-lb.local',
        'x-forwarded-proto': 'https, http',
      }),
    );
    expect(url.host).toBe(canonical.host);
  });

  it('preserves query strings on the redirect path', () => {
    const url = publicRedirectUrl('/checkout/start?plan=starter', fakeRequest({}));
    expect(url.toString()).toBe(`${canonical.origin}/checkout/start?plan=starter`);
  });

  // `new URL(path, base)` lets an absolute path replace the base outright, so
  // the origin check above is worthless unless the path is validated too.
  it('refuses an absolute path that would replace the canonical origin', () => {
    const url = publicRedirectUrl('https://attacker.example/steal', fakeRequest({}));
    expect(url.toString()).toBe(`${canonical.origin}/dashboard`);
  });

  it('refuses a protocol-relative path', () => {
    const url = publicRedirectUrl('//attacker.example/steal', fakeRequest({}));
    expect(url.toString()).toBe(`${canonical.origin}/dashboard`);
  });

  it('refuses a backslash-prefixed path browsers may read as protocol-relative', () => {
    const url = publicRedirectUrl('/\\attacker.example', fakeRequest({}));
    expect(url.toString()).toBe(`${canonical.origin}/dashboard`);
  });
});
