import { describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { publicRedirectUrl } from './public-origin';

function fakeRequest(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe('publicRedirectUrl', () => {
  it('uses X-Forwarded-Host and defaults to https', () => {
    const url = publicRedirectUrl(
      '/dashboard/settings/google',
      fakeRequest({ 'x-forwarded-host': 'incfrog.ai' }),
    );
    expect(url.toString()).toBe('https://incfrog.ai/dashboard/settings/google');
  });

  it('honors X-Forwarded-Proto http for local proxies', () => {
    const url = publicRedirectUrl(
      '/sign-in',
      fakeRequest({ 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' }),
    );
    expect(url.toString()).toBe('http://localhost:3000/sign-in');
  });

  it('treats any non-http forwarded proto as https', () => {
    const url = publicRedirectUrl(
      '/sign-in',
      fakeRequest({ 'x-forwarded-host': 'incfrog.ai', 'x-forwarded-proto': 'weird' }),
    );
    expect(url.protocol).toBe('https:');
  });

  it('uses only the first value of comma-separated forwarded headers', () => {
    const url = publicRedirectUrl(
      '/dashboard',
      fakeRequest({
        'x-forwarded-host': 'incfrog.ai, internal-lb.local',
        'x-forwarded-proto': 'https, http',
      }),
    );
    expect(url.toString()).toBe('https://incfrog.ai/dashboard');
  });

  it('falls back to the canonical site URL without forwarded headers', () => {
    // The request URL (container bind address) must never leak into the
    // redirect — the canonical siteUrl fallback is used instead.
    const url = publicRedirectUrl('/dashboard/settings/google', fakeRequest({}));
    expect(url.pathname).toBe('/dashboard/settings/google');
    expect(url.hostname).not.toBe('0.0.0.0');
  });

  it('falls back to the canonical site URL for a malformed forwarded host', () => {
    const url = publicRedirectUrl(
      '/dashboard',
      fakeRequest({ 'x-forwarded-host': 'bad host with spaces' }),
    );
    expect(url.pathname).toBe('/dashboard');
    expect(url.hostname).not.toBe('0.0.0.0');
  });

  it('preserves query strings on the redirect path', () => {
    const url = publicRedirectUrl(
      '/checkout/start?plan=starter',
      fakeRequest({ 'x-forwarded-host': 'incfrog.ai' }),
    );
    expect(url.toString()).toBe('https://incfrog.ai/checkout/start?plan=starter');
  });
});
