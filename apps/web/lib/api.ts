import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import {
  GoogleAuthorizeResponseSchema,
  GoogleConnectionStatusResponseSchema,
  GoogleDisconnectResponseSchema,
  SessionUserSchema,
  type ApiEnvelope,
  type GoogleAuthorizeResponse,
  type GoogleConnectionStatusResponse,
  type GoogleDisconnectResponse,
  type SessionUser,
} from '@voiceforge/shared';
import { buildApiContextHeaders } from './api-context-headers';
import { extractSupabaseAccessToken } from './supabase/access-token';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
// Prefer the private service-to-service URL (e.g. http://api:4000 on the Docker
// network) so server-side calls never loop out through nginx; fall back to the
// public URL. The resolved base must include the NestJS global prefix /api/v1.
const API_BASE = resolveApiBase(process.env.INTERNAL_API_URL, process.env.NEXT_PUBLIC_API_URL);

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
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies();
  const accessToken = extractSupabaseAccessToken(cookieStore.getAll(), SUPABASE_URL);
  const method = (init.method ?? 'GET').toUpperCase();
  const cacheableGet = method === 'GET' && !init.body && !init.headers && !init.signal;

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
    const detail = body?.error?.message ?? 'request failed';
    const method = (init.method ?? 'GET').toUpperCase();
    // Fold the route and status into the message so distinct faults get
    // distinct error-tracking fingerprints, instead of every API 500
    // collapsing into the masked `Unexpected server error.` constant.
    const message = `${method} ${path} -> ${res.status} ${code}: ${detail}`;
    throw new ApiCallError(code, message, res.status, body?.error?.details);
  }
  return body.data as T;
}

/**
 * The session for the current request.
 *
 * Every dashboard page used to `await apiFetch('/auth/me')` itself, on top of
 * the layout's own call, and only then start fetching its data — a serial
 * chain of round trips on every navigation. `apiFetch` already dedups plain
 * GETs through React `cache()`, so within one server render this resolves once
 * and every later caller gets the same in-flight promise; the waterfall
 * collapses to a single `/auth/me`.
 *
 * Kept as a named helper so pages express the intent ("reuse the request's
 * session") rather than relying on an implementation detail of `apiFetch`.
 */
export async function getSessionUser(): Promise<SessionUser> {
  return SessionUserSchema.parse(await apiFetch<unknown>('/auth/me'));
}

/**
 * Same, but converts an expired/absent session into the sign-in redirect.
 * This is the server-side enforcement point for dashboard routes.
 */
export async function requireSessionUser(nextPath = '/dashboard'): Promise<SessionUser> {
  try {
    return await getSessionUser();
  } catch (err) {
    if (err instanceof ApiCallError && err.status === 401) {
      redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
    }
    throw err;
  }
}

/**
 * Server-side client for the unified Google Workspace connection.
 * `authorize` returns the consent URL, `status` powers the settings page
 * state, and `disconnect` removes the stored token set.
 */
export const googleConnectionApi = {
  async authorize(workspaceId: string): Promise<GoogleAuthorizeResponse> {
    return GoogleAuthorizeResponseSchema.parse(
      await apiFetch<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/google/authorize`),
    );
  },
  async status(workspaceId: string): Promise<GoogleConnectionStatusResponse> {
    return GoogleConnectionStatusResponseSchema.parse(
      await apiFetch<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/google/status`),
    );
  },
  async callback(
    workspaceId: string,
    code: string,
    state: string,
  ): Promise<GoogleConnectionStatusResponse> {
    return GoogleConnectionStatusResponseSchema.parse(
      await apiFetch<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/google/callback`, {
        method: 'POST',
        body: JSON.stringify({ code, state }),
      }),
    );
  },
  async disconnect(workspaceId: string): Promise<GoogleDisconnectResponse> {
    return GoogleDisconnectResponseSchema.parse(
      await apiFetch<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/google/disconnect`, {
        method: 'DELETE',
      }),
    );
  },
};

export class ApiCallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    // Without this, error tracking labels every ApiCallError as a generic `Error`.
    this.name = 'ApiCallError';
  }
}
