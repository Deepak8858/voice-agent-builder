'use client';

import { createClient } from '@supabase/supabase-js';
import { useSession } from '@clerk/nextjs';

/**
 * Client-side Supabase client authenticated via Clerk session token.
 * Use this in React components for RLS-protected reads/writes.
 */
export function useClerkSupabaseClient() {
  const { session } = useSession();

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      async accessToken() {
        return session?.getToken() ?? null;
      },
    },
  );
}
