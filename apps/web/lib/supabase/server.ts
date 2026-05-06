import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

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
 * Server-side Supabase client authenticated via the user's session
 * cookies. Use in Server Components, Route Handlers, and Server Actions.
 * RLS will run as the signed-in user.
 */
export async function createServerSupabaseClient() {
  const { url, key } = getEnv();
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(list) {
        try {
          for (const { name, value, options } of list) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component context — cookies are read-only here. The
          // session refresh path in middleware.ts handles writes.
        }
      },
    },
  });
}
