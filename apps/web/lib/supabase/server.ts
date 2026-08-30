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
 *
 * No `cookieOptions`: @supabase/ssr applies DEFAULT_COOKIE_OPTIONS
 * (`path: '/'`, `sameSite: 'lax'`, `httpOnly: false`) either way, and
 * `httpOnly: true` would hide the session from createBrowserSupabaseClient(),
 * which reads it out of `document.cookie` — that is an outage, not a fix. Any
 * other attribute override has to be made in client.ts at the same time or
 * the two writers disagree and the last write wins.
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
          // Server Component context — cookies are read-only here, so a
          // render-triggered refresh cannot persist. Not middleware's job
          // either: updateSupabaseSession() only checks that an auth cookie
          // exists, it never builds a client or writes one. The real writers
          // are the browser client (autoRefreshToken, document.cookie) and
          // route handlers like app/auth/callback, where cookies().set works.
        }
      },
    },
  });
}
