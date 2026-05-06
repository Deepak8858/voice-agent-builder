import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export interface SessionUser {
  authUserId: string;
  appUserId: string;
  email: string;
  activeOrgId: string | null;
  activeOrgRole: string | null;
}

/**
 * Get current user session from Supabase cookies.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // Get app user profile
  const appUserId = user.user_metadata?.app_user_id as string | undefined;

  // Get active org from JWT app_metadata
  const activeOrgId = user.app_metadata?.active_org_id as string | undefined ?? null;
  const activeOrgRole = user.app_metadata?.active_org_role as string | undefined ?? null;

  return {
    authUserId: user.id,
    appUserId: appUserId ?? '',
    email: user.email ?? '',
    activeOrgId,
    activeOrgRole,
  };
}

/**
 * Require user session. Redirect to /sign-in if not authenticated.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/sign-in');
  }
  return user;
}

/**
 * Require authenticated user with an active organization.
 * Redirects to /onboarding if user has no active org.
 */
export async function requireActiveOrg(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.activeOrgId) {
    redirect('/onboarding');
  }
  return user;
}