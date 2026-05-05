import { auth, redirectToSignIn } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const PUBLIC_ROUTES = [
  '/',
  '/sign-in',
  '/sign-up',
  '/api/health',
  '/api/v1/health',
];

export default async function middleware(req: Request) {
  const { pathname } = req.nextUrl;

  // Allow public routes and Clerk static assets
  if (
    PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith('/sign-in') || pathname.startsWith('/sign-up')) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Protect all /dashboard/* routes
  if (pathname.startsWith('/dashboard')) {
    const { userId } = await auth();
    if (!userId) {
      return redirectToSignIn({ returnBackUrl: pathname });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)'],
};
