import { createClient } from '@supabase/supabase-js';

/**
 * Admin/service-role Supabase client. NEVER expose this to the browser.
 * Use only in server-side trusted contexts (webhooks, background jobs,
 * provider callbacks, internal analytics) where RLS alone is insufficient.
 */
export function createSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
