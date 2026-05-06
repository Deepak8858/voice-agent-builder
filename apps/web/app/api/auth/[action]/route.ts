import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:4000';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));

  // Build context headers from Supabase user
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

  let targetPath = '/api/v1';
  let method = 'GET';
  let apiBody: unknown = undefined;

  switch (action) {
    case 'sign-out':
      await supabase.auth.signOut();
      return NextResponse.json({ success: true });

    case 'me':
      targetPath = '/auth/me';
      method = 'GET';
      break;

    case 'switch-org': {
      // body: { orgId }
      const { orgId } = body as { orgId?: string };
      if (!orgId) return NextResponse.json({ error: 'orgId required' }, { status: 400 });

      const appUserId = user.user_metadata?.app_user_id;
      if (!appUserId) return NextResponse.json({ error: 'User profile not found' }, { status: 400 });

      // Find membership where workspace belongs to target organization
      const { data: membership } = await supabase
        .from('memberships')
        .select('role, workspaces!inner(organization_id)')
        .eq('user_id', appUserId)
        .eq('workspaces.organization_id', orgId)
        .single();

      if (!membership) {
        return NextResponse.json({ error: 'Not a member of that organization' }, { status: 403 });
      }

      // Update JWT app_metadata
      const orgRole = membership.role;

      const adminClient = (await import('@/lib/supabase/admin')).createSupabaseAdminClient();
      await adminClient.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, active_org_id: orgId },
        app_metadata: { ...user.app_metadata, active_org_id: orgId, active_org_role: orgRole },
      });

      return NextResponse.json({ success: true, activeOrgId: orgId });
    }

    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
  }

  // Proxy to NestJS
  const apiRes = await fetch(`${INTERNAL_API_URL}${targetPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: method !== 'GET' ? JSON.stringify(apiBody) : undefined,
    cache: 'no-store',
  });

  const data = await apiRes.json().catch(() => null);
  return NextResponse.json(data ?? {}, { status: apiRes.status });
}