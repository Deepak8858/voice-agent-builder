import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    const redirect = new URL('/sign-in', req.url);
    redirect.searchParams.set('error', error);
    redirect.searchParams.set('error_description', errorDescription ?? '');
    return NextResponse.redirect(redirect);
  }

  if (!code) {
    return NextResponse.redirect(new URL('/sign-in', req.url));
  }

  const supabase = await createServerSupabaseClient();

  const { data, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

  if (sessionError || !data.user) {
    const redirect = new URL('/sign-in', req.url);
    redirect.searchParams.set('error', 'session_error');
    redirect.searchParams.set('error_description', sessionError?.message ?? 'Failed to create session');
    return NextResponse.redirect(redirect);
  }

  // Check if user has an active org in app_metadata
  const activeOrgId = data.user.app_metadata?.active_org_id;

  if (!activeOrgId) {
    // New user or no org — redirect to onboarding
    return NextResponse.redirect(new URL('/onboarding', req.url));
  }

  // Already has org — go to dashboard
  return NextResponse.redirect(new URL(next, req.url));
}