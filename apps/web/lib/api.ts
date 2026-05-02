import 'server-only';
import { auth } from '@clerk/nextjs/server';
import type { ApiEnvelope } from '@voiceforge/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-requested-with', 'XMLHttpRequest');
  if (token) headers.set('authorization', `Bearer ${token}`);

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
