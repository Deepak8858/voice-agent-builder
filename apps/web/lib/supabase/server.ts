import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client authenticated via Clerk session token.
 * Use in Server Components or server actions where RLS should enforce
 * permissions based on the current user's Clerk identity.
 */
export async function createServerSupabaseClient() {
  const { getToken } = await auth();

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      async accessToken() {
        return getToken();
      },
    },
  );
}
