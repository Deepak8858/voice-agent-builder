import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { publicRedirectUrl } from '@/lib/public-origin';

const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  'signup',
  'email',
  'recovery',
  'invite',
  'email_change',
  'magiclink',
];

function sessionErrorRedirect(req: NextRequest, message: string) {
  const redirect = publicRedirectUrl('/sign-in', req);
  redirect.searchParams.set('error', 'session_error');
  redirect.searchParams.set('error_description', message);
  return NextResponse.redirect(redirect);
}

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const otpType = searchParams.get('type') as EmailOtpType | null;
  const next = safeRedirectPath(searchParams.get('next'));
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    const redirect = publicRedirectUrl('/sign-in', req);
    redirect.searchParams.set('error', error);
    redirect.searchParams.set('error_description', errorDescription ?? '');
    return NextResponse.redirect(redirect);
  }

  const usableTokenHash = tokenHash && otpType && EMAIL_OTP_TYPES.includes(otpType);

  if (!code && !usableTokenHash) {
    return NextResponse.redirect(publicRedirectUrl('/sign-in', req));
  }

  const supabase = await createServerSupabaseClient();

  let user;
  if (code) {
    const { data, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

    if (sessionError || !data.user) {
      return sessionErrorRedirect(req, sessionError?.message ?? 'Failed to create session');
    }

    user = data.user;
  } else {
    // Email-confirmation links carry a token_hash instead of a PKCE code, so
    // they work when opened on a device without the code-verifier cookie. The
    // server client's cookie adapter persists the verified session.
    const { data, error: otpError } = await supabase.auth.verifyOtp({
      type: otpType!,
      token_hash: tokenHash!,
    });

    if (otpError || !data.user) {
      return sessionErrorRedirect(req, otpError?.message ?? 'Failed to create session');
    }

    if (otpType === 'recovery') {
      return NextResponse.redirect(publicRedirectUrl('/reset-password', req));
    }

    user = data.user;
  }

  const adminClient = createSupabaseAdminClient();

  // For new OAuth signups, app_metadata.app_user_id is not set by default.
  // Look up the public.users row and update server-controlled metadata.
  let appUserId = user.app_metadata?.app_user_id as string | undefined;
  /** Set when server-controlled claims were written and the token has to catch up. */
  let claimsChanged = false;
  if (!appUserId) {
    const { data: appUser } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (appUser) {
      appUserId = appUser.id;
      const { error } = await adminClient.auth.admin.updateUserById(user.id, {
        app_metadata: { ...user.app_metadata, app_user_id: appUser.id },
      });
      if (error) {
        return sessionErrorRedirect(req, error.message);
      }
      claimsChanged = true;
    }
  }

  // Only signup sets `active_org_id`, so a returning user whose token predates it
  // — a magic link, an invite, a password reset — used to be sent through
  // /onboarding even though they already own a workspace. The memberships are the
  // truth; the claim is a cache, so refill it here rather than bounce.
  let activeOrgId = user.app_metadata?.active_org_id as string | undefined;

  if (!activeOrgId && appUserId) {
    const { data: memberships } = await supabase
      .from('memberships')
      .select('role, created_at, workspaces!inner(organization_id)')
      .eq('user_id', appUserId)
      // Oldest first, so a user in several organizations lands in the same one
      // every time instead of wherever the query planner happened to look.
      .order('created_at', { ascending: true })
      .limit(1);

    const membership = memberships?.[0];
    // PostgREST returns an embedded row as an object, or as an array when it
    // cannot prove the relation is many-to-one. Both shapes are read here so a
    // schema-cache difference cannot silently send the user to onboarding.
    const joined = membership?.workspaces as
      | { organization_id?: string }
      | { organization_id?: string }[]
      | undefined;
    const organizationId = (Array.isArray(joined) ? joined[0] : joined)?.organization_id;

    if (membership && organizationId) {
      const { error } = await adminClient.auth.admin.updateUserById(user.id, {
        app_metadata: {
          ...user.app_metadata,
          ...(appUserId ? { app_user_id: appUserId } : {}),
          active_org_id: organizationId,
          active_org_role: membership.role,
        },
      });
      // Sending them on without the claim would hand the dashboard a session
      // that row-level security reads as belonging to no organization, and
      // /onboarding would offer to create the workspace they already have.
      if (error) {
        return sessionErrorRedirect(req, error.message);
      }
      activeOrgId = organizationId;
      claimsChanged = true;
    }
  }

  // The session cookie was minted before those metadata writes, and row-level
  // security reads `active_org_id` from the token, not from the user row. Without
  // this the first page load after sign-in still carries the empty claim.
  if (claimsChanged) {
    await supabase.auth.refreshSession();
  }

  if (!activeOrgId) {
    // New user or no org — push to onboarding and preserve the post-signup
    // redirect target (e.g. /checkout/start?plan=starter) so paid plan
    // intent survives org creation.
    const onboarding = publicRedirectUrl('/onboarding', req);
    if (next && next !== '/dashboard') {
      onboarding.searchParams.set('next', next);
    }
    return NextResponse.redirect(onboarding);
  }

  // Already has org — go to dashboard (or the explicit `next` target).
  return NextResponse.redirect(publicRedirectUrl(next, req));
}
