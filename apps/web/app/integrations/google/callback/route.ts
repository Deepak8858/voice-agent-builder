import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { googleConnectionApi, ApiCallError } from '@/lib/api';
import { publicRedirectUrl } from '@/lib/public-origin';

const SETTINGS_PATH = '/dashboard/settings/google';

const WorkspaceIdSchema = z.string().uuid();

/**
 * Browser-facing Google OAuth callback. Google redirects here with `code`
 * and the signed `state` we issued in GET /workspaces/:id/google/authorize.
 * We forward both to the API (which verifies the state signature, exchanges
 * the code, and stores encrypted tokens), then bounce back to the settings
 * page. Mirrors apps/web/app/auth/callback/route.ts.
 */
export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const oauthError = searchParams.get('error');

  // Never derive the redirect from req.url: in the standalone production
  // server it reflects the container bind address (https://0.0.0.0:3000),
  // which is unreachable from the user's browser.
  const redirect = publicRedirectUrl(SETTINGS_PATH, req);

  if (oauthError) {
    // e.g. access_denied when the user cancels the consent screen.
    redirect.searchParams.set('error', oauthError);
    return NextResponse.redirect(redirect);
  }

  if (!code || !state) {
    redirect.searchParams.set('error', 'missing_code_or_state');
    return NextResponse.redirect(redirect);
  }

  // The signed state is `workspaceId.expiresAtMs.nonce.signature`; the first
  // segment tells us which workspace's callback endpoint to call. The API
  // re-verifies the full signature, so this is routing info only — but it is
  // interpolated into an API path, so it must be a well-formed UUID before we
  // use it.
  const workspaceIdParse = WorkspaceIdSchema.safeParse(state.split('.')[0]);
  if (!workspaceIdParse.success) {
    redirect.searchParams.set('error', 'invalid_state');
    return NextResponse.redirect(redirect);
  }
  const workspaceId = workspaceIdParse.data;

  try {
    await googleConnectionApi.callback(workspaceId, code, state);
    redirect.searchParams.set('connected', '1');
  } catch (err) {
    console.error('[google-callback] token exchange failed', err);
    redirect.searchParams.set(
      'error',
      err instanceof ApiCallError ? err.code : 'callback_failed',
    );
  }

  return NextResponse.redirect(redirect);
}
