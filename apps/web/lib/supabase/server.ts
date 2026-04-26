import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client. Call this inside server components, route
 * handlers, and server actions. Cookies are forwarded so supabase-js can
 * read the authenticated session if present.
 */
export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
  }

  const store = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return store.getAll().map(({ name, value }) => ({ name, value }));
      },
      setAll(list) {
        // In server components cookies() is read-only; guard the write.
        try {
          for (const { name, value, options } of list) {
            store.set({ name, value, ...options });
          }
        } catch {
          // Ignore in RSC; set via middleware/route handler instead.
        }
      },
    },
  });
}
