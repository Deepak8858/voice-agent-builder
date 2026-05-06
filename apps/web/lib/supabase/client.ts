'use client';

import { createBrowserClient } from '@supabase/ssr';

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY in .env',
    );
  }
  return { url, key };
}

/**
 * Browser Supabase client. RLS runs as the authenticated user (cookies).
 */
export function createBrowserSupabaseClient() {
  const { url, key } = getEnv();
  return createBrowserClient(url, key);
}
