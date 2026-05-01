'use client';

import { createClient } from '@supabase/supabase-js';
import { useSession } from '@clerk/nextjs';

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
 * Client-side Supabase client authenticated via Clerk session token.
 * Use this in React components for RLS-protected reads/writes.
 */
export function useClerkSupabaseClient() {
  const { session } = useSession();
  const { url, key } = getEnv();

  return createClient(url, key, {
    async accessToken() {
      return session?.getToken() ?? null;
    },
  });
}
