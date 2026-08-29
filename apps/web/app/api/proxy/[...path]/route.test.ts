import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// The handlers read cookies() and extract a Supabase token before forwarding.
// Both are mocked so these tests exercise only the proxy's own gates: the
// path allow-list, the Origin check, and the forward itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [] }),
}));
vi.mock('@/lib/supabase/access-token', () => ({
  extractSupabaseAccessToken: () => 'test-access-token',
}));

import { GET, POST } from './route';

function fakeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: new Headers(headers),
    nextUrl: { search: '' },
    signal: undefined,
    text: async () => '{}',
  } as unknown as NextRequest;
}

function routeParams(...segments: string[]) {
  return { params: Promise.resolve({ path: segments }) };
}

const fetchMock = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ success: true, data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('proxy route guards', () => {
  it('returns 404 for a path outside the allow-list without forwarding', async () => {
    const res = await POST(fakeRequest(), routeParams('admin', 'retention'));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a disallowed GET path before the SSE branch can run', async () => {
    const res = await GET(fakeRequest(), routeParams('admin', 'retention', 'live'));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a mutating request with a cross-site Origin', async () => {
    const res = await POST(
      fakeRequest({ origin: 'https://evil.example', host: 'incfrog.ai' }),
      routeParams('workspaces', 'ws1', 'agents'),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a mutating request whose Origin matches the Host', async () => {
    const res = await POST(
      fakeRequest({ origin: 'https://incfrog.ai', host: 'incfrog.ai' }),
      routeParams('workspaces', 'ws1', 'agents'),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('forwards an allow-listed GET with no Origin (EventSource sends none)', async () => {
    const res = await GET(fakeRequest(), routeParams('workspaces', 'ws1', 'agents'));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const target = String(fetchMock.mock.calls[0][0]);
    expect(target.endsWith('/workspaces/ws1/agents')).toBe(true);
    expect(await res.json()).toEqual({ success: true, data: { ok: true } });
  });
});
