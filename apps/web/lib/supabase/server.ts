import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing Supabase client environment variables. ' +
        'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env',
    );
  }
  return { url, key };
}

/**
 * Server-side Supabase client authenticated via Clerk session token.
 * Use in Server Components or server actions where RLS should enforce
 * permissions based on the current user's Clerk identity.
 */
export async function createServerSupabaseClient() {
  const { getToken } = await auth();
  const { url, key } = getEnv();

  return createClient(url, key, {
    async accessToken() {
      return getToken();
    },
  });
}
