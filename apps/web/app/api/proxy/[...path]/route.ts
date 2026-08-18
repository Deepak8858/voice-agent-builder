import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { buildApiContextHeaders } from '@/lib/api-context-headers';
import { extractSupabaseAccessToken } from '@/lib/supabase/access-token';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
// Prefer the private service-to-service URL (e.g. http://api:4000 on the Docker
// network) so proxied traffic never loops out through nginx; fall back to the
// public URL. The resolved base must include the NestJS global prefix /api/v1.
const API_BASE = resolveApiBase(
  process.env.INTERNAL_API_URL,
  process.env.NEXT_PUBLIC_API_URL,
);

function resolveApiBase(
  internalApiUrl: string | undefined,
  publicApiUrl: string | undefined,
): string {
  if (internalApiUrl) {
    const parsed = new URL(internalApiUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/') {
      throw new Error('INTERNAL_API_URL must be an HTTP(S) origin without a path');
    }
    return `${parsed.origin}/api/v1`;
  }
  return publicApiUrl ?? 'http://localhost:4000/api/v1';
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

function apiTarget(req: NextRequest, pathString: string): string {
  return `${API_BASE}${pathString}${req.nextUrl.search}`;
}

/** Statuses for which the Response constructor forbids a body. */
export function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

/**
 * Relay a non-streaming upstream reply to the browser. A null-body status such
 * as 204 must carry no body, so return a body-free Response for it. Passing a
 * body to those statuses makes the Response constructor throw and turns a
 * successful upstream reply into an unhandled 500. Exported for tests.
 */
export async function relayJsonResponse(apiRes: Response): Promise<Response> {
  if (isNullBodyStatus(apiRes.status)) {
    return new Response(null, { status: apiRes.status });
  }
  const data = await apiRes.json().catch(() => null);
  return NextResponse.json(data ?? {}, { status: apiRes.status });
}

/**
 * API proxy route. Receives browser fetches, validates Supabase session,
 * then forwards to NestJS with the internal key and Supabase bearer token.
 */
async function getApiContextHeaders(contentType?: string) {
  const cookieStore = await cookies();
  const accessToken = extractSupabaseAccessToken(cookieStore.getAll(), SUPABASE_URL);

  if (!accessToken) return null;

  return buildApiContextHeaders(accessToken, {
    internalApiKey: INTERNAL_API_KEY,
    contentType,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = '/' + (path ?? []).join('/');
  const headers = await getApiContextHeaders(req.headers.get('content-type') ?? 'application/json');

  if (!headers) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const body = await req.text();

  const apiRes = await fetch(apiTarget(req, pathString), {
    method: 'POST',
    headers,
    body,
    cache: 'no-store',
    ...(req.signal ? { signal: req.signal } : {}),
  });

  return new Response(apiRes.body, {
    status: apiRes.status,
    headers: {
      'content-type': apiRes.headers.get('content-type') ?? 'application/json',
    },
  });
}

/**
 * GET proxy for fetching data or SSE streams
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = '/' + (path ?? []).join('/');
  const headers = await getApiContextHeaders();

  if (!headers) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const apiRes = await fetch(apiTarget(req, pathString), {
    method: 'GET',
    headers,
    cache: 'no-store',
  });

  // SSE stream: pass raw body through as streaming response
  const contentType = apiRes.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream') || pathString.includes('/live')) {
    return new Response(apiRes.body, {
      status: apiRes.status,
      headers: {
        'content-type': contentType || 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  return relayJsonResponse(apiRes);
}

/**
 * PATCH proxy
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = '/' + (path ?? []).join('/');
  const headers = await getApiContextHeaders(req.headers.get('content-type') ?? 'application/json');

  if (!headers) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const body = await req.text();

  const apiRes = await fetch(apiTarget(req, pathString), {
    method: 'PATCH',
    headers,
    body,
    cache: 'no-store',
  });

  return relayJsonResponse(apiRes);
}

/**
 * PUT proxy (needed for flow builder saves)
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = '/' + (path ?? []).join('/');
  const headers = await getApiContextHeaders(req.headers.get('content-type') ?? 'application/json');

  if (!headers) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const body = await req.text();

  const apiRes = await fetch(apiTarget(req, pathString), {
    method: 'PUT',
    headers,
    body,
    cache: 'no-store',
  });

  return relayJsonResponse(apiRes);
}

/**
 * DELETE proxy
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = '/' + (path ?? []).join('/');
  const headers = await getApiContextHeaders();

  if (!headers) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const apiRes = await fetch(apiTarget(req, pathString), {
    method: 'DELETE',
    headers,
    cache: 'no-store',
  });

  return relayJsonResponse(apiRes);
}
