import type { NextRequest } from 'next/server';
import { buildContentSecurityPolicy } from './lib/content-security-policy';
import { updateSupabaseSession } from './middleware-utils';

/**
 * Next.js middleware entry point.
 * Protects routes requiring authentication by checking Supabase session.
 * Uses updateSupabaseSession() from middleware-utils.ts for session refresh
 * and auth validation.
 */
export async function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);

  const response = await updateSupabaseSession(req, requestHeaders);
  response.headers.set('Content-Security-Policy', contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
