import 'server-only';
import type { ApiEnvelope } from '@voiceforge/shared';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

/**
 * Server-side API fetch. Used in Server Components and Route Handlers.
 * Reads Supabase session from cookies, adds internal key + user context,
 * then calls NestJS directly.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-internal-key', INTERNAL_API_KEY ?? '');
  headers.set('x-requested-with', 'XMLHttpRequest');

  if (user) {
    headers.set('x-user-id', user.id);
    headers.set('x-user-email', user.email ?? '');
    if (user.user_metadata?.app_user_id) {
      headers.set('x-app-user-id', user.user_metadata.app_user_id as string);
    }
    if (user.app_metadata?.active_org_id) {
      headers.set('x-org-id', user.app_metadata.active_org_id as string);
    }
    if (user.app_metadata?.active_org_role) {
      headers.set('x-org-role', user.app_metadata.active_org_role as string);
    }
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