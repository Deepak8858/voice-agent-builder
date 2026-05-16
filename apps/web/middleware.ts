import { NextResponse, type NextRequest } from 'next/server';
import { updateSupabaseSession } from './middleware-utils';

/**
 * Next.js middleware entry point.
 * Protects routes requiring authentication by checking Supabase session.
 * Uses updateSupabaseSession() from middleware-utils.ts for session refresh
 * and auth validation.
 */
export async function middleware(req: NextRequest) {
  return updateSupabaseSession(req);
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/agents/:path*',
    '/calls/:path*',
    '/onboarding/:path*',
    '/invite/:path*',
    '/settings/:path*',
    '/knowledge/:path*',
    '/integrations/:path*',
    '/compliance/:path*',
    '/analytics/:path*',
    '/white-label/:path*',
    '/clients/:path*',
    '/billing/:path*',
  ],
};
