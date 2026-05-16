'use client';

import { useCallback, useState } from 'react';
import type { ApiEnvelope } from '@voiceforge/shared';

const API_BASE = '/api/proxy';

export interface LimitExceededError extends Error {
  code: 'LIMIT_EXCEEDED';
  limitType?: string;
  currentPlan?: string;
}

/**
 * Browser hook for API calls. Uses fetch to Next.js proxy which adds
 * session context and internal key before forwarding to NestJS.
 */
export function useApi() {
  const [limitExceeded, setLimitExceeded] = useState<{ type?: string; plan?: string } | null>(null);

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

      // Handle 403 with limit exceeded
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as ApiEnvelope<null> | null;
        if (body?.error?.code === 'PLAN_LIMIT_EXCEEDED') {
          const err = new Error(body.error.message ?? 'Limit exceeded') as LimitExceededError;
          err.code = 'LIMIT_EXCEEDED';
          err.limitType = body.error.details?.limitType as string | undefined;
          err.currentPlan = body.error.details?.currentPlan as string | undefined;
          setLimitExceeded({ type: err.limitType, plan: err.currentPlan });
          throw err;
        }
      }

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

  return { call, limitExceeded, clearLimitExceeded: () => setLimitExceeded(null) };
}