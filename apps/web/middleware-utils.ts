import { NextResponse, type NextRequest } from 'next/server';

/**
 * Performs a cheap auth-cookie presence check in middleware.
 * Full session validation happens in the dashboard layout and API.
 */
const PROTECTED_PREFIXES = [
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

export async function updateSupabaseSession(req: NextRequest): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  const needsAuth = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  if (needsAuth && !hasSupabaseAuthCookie(req)) {
    const redirect = req.nextUrl.clone();
    redirect.pathname = '/sign-in';
    redirect.searchParams.set('next', path);
    return NextResponse.redirect(redirect);
  }

  return NextResponse.next({ request: req });
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
