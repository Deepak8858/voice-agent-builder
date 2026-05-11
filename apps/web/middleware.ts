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
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (.*) (e.g. logo.png, pdf files)
     * - api routes (handled separately by API layer)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$)).*',
  ],
};
