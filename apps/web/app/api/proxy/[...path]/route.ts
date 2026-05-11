import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const INTERNAL_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * API proxy route. Receives browser fetches, validates Supabase session,
 * then forwards to NestJS with internal key + user/org context headers.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = '/' + (path ?? []).join('/');
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  // Build context headers from Supabase user
  const headers: Record<string, string> = {
    'content-type': req.headers.get('content-type') ?? 'application/json',
    'x-internal-key': INTERNAL_API_KEY ?? '',
    'x-user-id': user.id,
    'x-user-email': user.email ?? '',
  };

  if (user.user_metadata?.app_user_id) {
    headers['x-app-user-id'] = user.user_metadata.app_user_id as string;
  }

  if (user.app_metadata?.active_org_id) {
    headers['x-org-id'] = user.app_metadata.active_org_id as string;
  }

  if (user.app_metadata?.active_org_role) {
    headers['x-org-role'] = user.app_metadata.active_org_role as string;
  }

  if (user.app_metadata?.active_workspace_id) {
    headers['x-workspace-id'] = user.app_metadata.active_workspace_id as string;
  }

  const body = await req.text();

  const apiRes = await fetch(`${INTERNAL_API_URL}${pathString}`, {
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
 * GET proxy for fetching data
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const pathString = '/' + (path ?? []).join('/');
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const headers: Record<string, string> = {
    'x-internal-key': INTERNAL_API_KEY ?? '',
    'x-user-id': user.id,
    'x-user-email': user.email ?? '',
  };

  if (user.user_metadata?.app_user_id) {
    headers['x-app-user-id'] = user.user_metadata.app_user_id as string;
  }

  if (user.app_metadata?.active_org_id) {
    headers['x-org-id'] = user.app_metadata.active_org_id as string;
  }

  if (user.app_metadata?.active_org_role) {
    headers['x-org-role'] = user.app_metadata.active_org_role as string;
  }

  const apiRes = await fetch(`${INTERNAL_API_URL}${pathString}`, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });

  const data = await apiRes.json().catch(() => null);
  return NextResponse.json(data ?? {}, { status: apiRes.status });
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
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const headers: Record<string, string> = {
    'content-type': req.headers.get('content-type') ?? 'application/json',
    'x-internal-key': INTERNAL_API_KEY ?? '',
    'x-user-id': user.id,
    'x-user-email': user.email ?? '',
  };

  if (user.user_metadata?.app_user_id) {
    headers['x-app-user-id'] = user.user_metadata.app_user_id as string;
  }

  if (user.app_metadata?.active_org_id) {
    headers['x-org-id'] = user.app_metadata.active_org_id as string;
  }

  if (user.app_metadata?.active_org_role) {
    headers['x-org-role'] = user.app_metadata.active_org_role as string;
  }

  if (user.app_metadata?.active_workspace_id) {
    headers['x-workspace-id'] = user.app_metadata.active_workspace_id as string;
  }

  const body = await req.text();

  const apiRes = await fetch(`${INTERNAL_API_URL}${pathString}`, {
    method: 'PATCH',
    headers,
    body,
    cache: 'no-store',
  });

  const data = await apiRes.json().catch(() => null);
  return NextResponse.json(data ?? {}, { status: apiRes.status });
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
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, { status: 401 });
  }

  const headers: Record<string, string> = {
    'x-internal-key': INTERNAL_API_KEY ?? '',
    'x-user-id': user.id,
  };

  if (user.user_metadata?.app_user_id) {
    headers['x-app-user-id'] = user.user_metadata.app_user_id as string;
  }

  const apiRes = await fetch(`${INTERNAL_API_URL}${pathString}`, {
    method: 'DELETE',
    headers,
    cache: 'no-store',
  });

  const data = await apiRes.json().catch(() => null);
  return NextResponse.json(data ?? {}, { status: apiRes.status });
}