import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const isPublicRoute = [
  '/',
  '/sign-in',
  '/sign-up',
  '/api/webhooks',
];

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  // Static assets - skip
  if (
    pathname.startsWith('/_next') ||
    pathname.match(/\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$/)
  ) {
    return NextResponse.next();
  }

  // API routes - skip middleware, let API handle auth
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Public routes
  const isPublic = isPublicRoute.some((route) =>
    pathname === route || pathname.startsWith(`${route}/`)
  );
  if (isPublic) return NextResponse.next();

  // Protected routes - check Supabase session
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            req.cookies.set(name, value);
          });
        },
      },
    },
  );

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.redirect(new URL('/', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};