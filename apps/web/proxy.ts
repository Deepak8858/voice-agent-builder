import { clerkMiddleware, createRouteMatcher, redirectToSignIn } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks/(.*)',
  '/api/health',
  '/api/v1/auth/me',
]);

export default clerkMiddleware(async (auth, req: NextRequest) => {
  const { userId } = await auth();
  const pathname = req.nextUrl.pathname;

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith('/_next') ||
    pathname.match(/\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$/)
  ) {
    return NextResponse.next();
  }

  // Allow API routes (backend handles auth) and public routes
  if (pathname.startsWith('/api/') || isPublicRoute(req)) {
    return NextResponse.next();
  }

  // Protect everything else — redirect unauthenticated users to sign-in
  if (!userId) {
    return redirectToSignIn({ returnBackUrl: pathname });
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};
