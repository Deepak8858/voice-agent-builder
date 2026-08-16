import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import type { ApiEnvelope } from '@voiceforge/shared';
import { buildApiContextHeaders } from './api-context-headers';
import { extractSupabaseAccessToken } from './supabase/access-token';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
// Prefer the private service-to-service URL (e.g. http://api:4000 on the Docker
// network) so server-side calls never loop out through nginx; fall back to the
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

const cachedServerGet = cache(async (path: string, accessToken: string | null) =>
  rawApiFetch<unknown>(path, {}, accessToken),
);

/**
 * Server-side API fetch. Used in Server Components and Route Handlers.
 * Reads Supabase session from cookies, adds the internal key and verified
 * bearer token, then calls NestJS directly.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const cookieStore = await cookies();
  const accessToken = extractSupabaseAccessToken(cookieStore.getAll(), SUPABASE_URL);
  const method = (init.method ?? 'GET').toUpperCase();
  const cacheableGet =
    method === 'GET' &&
    !init.body &&
    !init.headers &&
    !init.signal;

  if (cacheableGet) {
    return (await cachedServerGet(path, accessToken)) as T;
  }

  return rawApiFetch<T>(path, init, accessToken);
}

async function rawApiFetch<T>(
  path: string,
  init: RequestInit,
  accessToken: string | null,
): Promise<T> {
  const headers = new Headers(init.headers);
  const contextHeaders = buildApiContextHeaders(accessToken, {
    internalApiKey: INTERNAL_API_KEY,
    contentType: 'application/json',
    requestedWith: 'XMLHttpRequest',
  });
  for (const [key, value] of Object.entries(contextHeaders)) {
    headers.set(key, value);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });

  const body = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || !body || body.success === false) {
    const code = body?.error?.code ?? 'INTERNAL_ERROR';
    const msg = body?.error?.message ?? `API ${res.status}`;
    throw new ApiCallError(code, msg, res.status, body?.error?.details);
  }
  return body.data as T;
}

export class ApiCallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
