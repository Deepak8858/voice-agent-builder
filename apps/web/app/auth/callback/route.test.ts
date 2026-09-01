import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { verifyOtp, exchangeCodeForSession },
  }),
}));

const updateUserById = vi.fn(async () => ({ error: null }));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({ auth: { admin: { updateUserById } } }),
}));

import { GET } from './route';

function callbackRequest(query: string): NextRequest {
  return {
    nextUrl: new URL(`http://localhost:3000/auth/callback?${query}`),
  } as unknown as NextRequest;
}

const verifiedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  app_metadata: { app_user_id: 'user-1' },
};

beforeEach(() => {
  verifyOtp.mockReset();
  exchangeCodeForSession.mockReset();
  updateUserById.mockClear();
});

describe('GET /auth/callback token_hash branch', () => {
  it('verifies a signup token and routes a user without an org to onboarding', async () => {
    verifyOtp.mockResolvedValue({ data: { user: verifiedUser }, error: null });

    const res = await GET(callbackRequest('token_hash=abc123&type=signup'));

    expect(verifyOtp).toHaveBeenCalledWith({ type: 'signup', token_hash: 'abc123' });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(new URL(res.headers.get('location')!).pathname).toBe('/onboarding');
  });

  it('sends a verified recovery token to the reset-password page', async () => {
    verifyOtp.mockResolvedValue({ data: { user: verifiedUser }, error: null });

    const res = await GET(callbackRequest('token_hash=abc123&type=recovery'));

    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'abc123' });
    expect(new URL(res.headers.get('location')!).pathname).toBe('/reset-password');
  });

  it('redirects to sign-in with session_error when verifyOtp fails', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: 'Token expired' } });

    const res = await GET(callbackRequest('token_hash=abc123&type=signup'));

    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('error')).toBe('session_error');
    expect(location.searchParams.get('error_description')).toBe('Token expired');
  });
});
