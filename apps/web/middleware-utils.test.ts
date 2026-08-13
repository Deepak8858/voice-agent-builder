import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { updateSupabaseSession } from './middleware-utils';

const SUPABASE_URL = 'https://projref.supabase.co';

function request(path: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(`http://localhost${path}`, { headers });
}

describe('updateSupabaseSession', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });

  it('redirects unauthenticated requests on protected routes to sign-in with a next param', async () => {
    const res = await updateSupabaseSession(request('/dashboard'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/sign-in?next=%2Fdashboard');
  });

  it('lets requests through when the configured project auth cookie exists', async () => {
    const res = await updateSupabaseSession(
      request('/dashboard', 'sb-projref-auth-token=session-value'),
    );

    expect(res.headers.get('location')).toBeNull();
  });

  it('accepts chunked auth cookie names for the configured project', async () => {
    const res = await updateSupabaseSession(
      request('/billing', 'sb-projref-auth-token.0=part-a; sb-projref-auth-token.1=part-b'),
    );

    expect(res.headers.get('location')).toBeNull();
  });

  it('rejects auth cookies minted for a different Supabase project', async () => {
    const res = await updateSupabaseSession(
      request('/dashboard', 'sb-attackerproject-auth-token=forged'),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/sign-in?next=%2Fdashboard');
  });

  it('rejects cookie names that merely resemble the auth cookie', async () => {
    const res = await updateSupabaseSession(
      request('/dashboard', 'sb-projref-auth-token-extra= forged'),
    );

    expect(res.status).toBe(307);
  });

  it('does not protect prefix lookalike routes', async () => {
    const res = await updateSupabaseSession(request('/dashboards'));

    expect(res.headers.get('location')).toBeNull();
  });

  it('leaves public routes alone without a session', async () => {
    const res = await updateSupabaseSession(request('/pricing'));

    expect(res.headers.get('location')).toBeNull();
  });

  it('preserves the full protected path in the next param', async () => {
    const res = await updateSupabaseSession(request('/settings/billing'));

    expect(res.headers.get('location')).toBe('http://localhost/sign-in?next=%2Fsettings%2Fbilling');
  });

  it('falls back to generic sb-*-auth-token matching when the Supabase URL is not configured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    const res = await updateSupabaseSession(
      request('/dashboard', 'sb-anyproject-auth-token=session-value'),
    );

    expect(res.headers.get('location')).toBeNull();
  });
});
