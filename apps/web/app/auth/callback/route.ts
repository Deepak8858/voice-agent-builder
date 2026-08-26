import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { publicRedirectUrl } from '@/lib/public-origin';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get('code');
  const next = safeRedirectPath(searchParams.get('next'));
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    const redirect = publicRedirectUrl('/sign-in', req);
    redirect.searchParams.set('error', error);
    redirect.searchParams.set('error_description', errorDescription ?? '');
    return NextResponse.redirect(redirect);
  }

  if (!code) {
    return NextResponse.redirect(publicRedirectUrl('/sign-in', req));
  }

  const supabase = await createServerSupabaseClient();

  const { data, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

  if (sessionError || !data.user) {
    const redirect = publicRedirectUrl('/sign-in', req);
    redirect.searchParams.set('error', 'session_error');
    redirect.searchParams.set('error_description', sessionError?.message ?? 'Failed to create session');
    return NextResponse.redirect(redirect);
  }

  const user = data.user;
  const adminClient = createSupabaseAdminClient();

  // For new OAuth signups, app_metadata.app_user_id is not set by default.
  // Look up the public.users row and update server-controlled metadata.
  if (!user.app_metadata?.app_user_id) {
    const { data: appUser } = await supabase
      .from('users')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (appUser) {
      await adminClient.auth.admin.updateUserById(user.id, {
        app_metadata: { ...user.app_metadata, app_user_id: appUser.id },
      });
    }
  }

  // Check if user has an active org in app_metadata
  const activeOrgId = user.app_metadata?.active_org_id;

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
