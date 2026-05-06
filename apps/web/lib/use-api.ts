'use client';

import { useCallback } from 'react';
import type { ApiEnvelope } from '@voiceforge/shared';

const API_BASE = '/api/proxy';

/**
 * Browser hook for API calls. Uses fetch to Next.js proxy which adds
 * session context and internal key before forwarding to NestJS.
 */
export function useApi() {
  const call = useCallback(
    async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
      if (!isFormData && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      headers.set('x-requested-with', 'XMLHttpRequest');

      const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
        credentials: 'include',
      });
      const body = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
      if (!res.ok || !body || body.success === false) {
        const code = body?.error?.code ?? 'INTERNAL_ERROR';
        const msg = body?.error?.message ?? `API ${res.status}`;
        const err = new Error(msg) as Error & { code?: string; details?: unknown };
        err.code = code;
        err.details = body?.error?.details;
        throw err;
      }
      return body.data as T;
    },
    [],
  );

  return { call };
}