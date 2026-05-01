import { createClient } from '@supabase/supabase-js';

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing Supabase admin environment variables. ' +
        'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env',
    );
  }
  return { url, key };
}

/**
 * Admin/service-role Supabase client. NEVER expose this to the browser.
 * Use only in server-side trusted contexts (webhooks, background jobs,
 * provider callbacks, internal analytics) where RLS alone is insufficient.
 */
export function createSupabaseAdminClient() {
  const { url, key } = getEnv();

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
