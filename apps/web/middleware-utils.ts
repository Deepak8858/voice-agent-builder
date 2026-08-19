import { NextResponse, type NextRequest } from 'next/server';

/**
 * Performs a cheap auth-cookie presence check in middleware.
 * Full session validation happens in the dashboard layout and API.
 */
export const PROTECTED_PREFIXES = [
  '/dashboard',
  '/agents',
  '/calls',
  '/onboarding',
  '/invite',
  '/settings',
  '/knowledge',
  '/integrations',
  '/compliance',
  '/analytics',
  '/white-label',
  '/clients',
  '/billing',
];

/**
 * Marketing and auth routes that are public by definition. Matching one skips
 * the cookie scan only after protected-route matching has run. Protected status
 * always wins if these prefixes overlap, so future route-list changes cannot
 * silently bypass the auth-cookie check.
 */
export const PUBLIC_PREFIXES = [
  '/',
  '/sign-in',
  '/sign-up',
  '/pricing',
  '/auth',
  '/legal',
  '/services',
  '/support',
  '/refund',
  '/privacypolicy',
];

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`)));
}

export async function updateSupabaseSession(
  req: NextRequest,
  requestHeaders = new Headers(req.headers),
): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  const pass = () => NextResponse.next({ request: { headers: requestHeaders } });

  const needsAuth = matchesPrefix(path, PROTECTED_PREFIXES);
  if (!needsAuth && matchesPrefix(path, PUBLIC_PREFIXES)) return pass();

  if (needsAuth && !hasSupabaseAuthCookie(req)) {
    const redirect = req.nextUrl.clone();
    redirect.pathname = '/sign-in';
    redirect.searchParams.set('next', path);
    return NextResponse.redirect(redirect);
  }

  return pass();
}

function hasSupabaseAuthCookie(req: NextRequest): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const projectRef = supabaseProjectRef(url);
  const expectedPrefix = projectRef ? `sb-${projectRef}-auth-token` : null;

  return req.cookies.getAll().some((cookie) => {
    if (expectedPrefix) {
      return cookie.name === expectedPrefix || cookie.name.startsWith(`${expectedPrefix}.`);
    }
    return cookie.name.startsWith('sb-') && cookie.name.includes('-auth-token');
  });
}

function supabaseProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.split('.')[0] ?? null;
  } catch {
    return null;
  }
}
