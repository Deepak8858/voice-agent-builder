import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-only Supabase client. Uses the publishable key and is safe to call
 * from client components. Clerk is the source of truth for identity \u2014 this
 * client is for direct data reads (RLS policies must enforce tenancy).
 */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
  }
  return createBrowserClient(url, key);
}
