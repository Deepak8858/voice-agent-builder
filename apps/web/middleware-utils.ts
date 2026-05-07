import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Refreshes the Supabase auth session cookies on every request.
 * Called from /middleware.ts. Returns either the next response or a
 * redirect to /sign-in for protected paths when no session is present.
 */
const PROTECTED_PREFIXES = ['/dashboard', '/agents', '/calls', '/onboarding', '/invite', '/settings'];

export async function updateSupabaseSession(req: NextRequest): Promise<NextResponse> {
  let res = NextResponse.next({ request: req });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return res;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(list) {
        for (const { name, value } of list) {
          req.cookies.set(name, value);
        }
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) {
          res.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = req.nextUrl.pathname;
  const needsAuth = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  if (needsAuth && !user) {
    const redirect = req.nextUrl.clone();
    redirect.pathname = '/sign-in';
    redirect.searchParams.set('next', path);
    return NextResponse.redirect(redirect);
  }

  return res;
}
