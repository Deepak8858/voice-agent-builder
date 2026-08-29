import { createHash, randomUUID } from 'crypto';
import { after, NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { captureServerEvent } from '@/lib/analytics/posthog-server';

interface OnboardingBody {
  orgName?: string;
  workspaceName?: string;
}

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as OnboardingBody;
  const orgName = normalizeName(body.orgName, 'Personal');
  const workspaceName = normalizeName(body.workspaceName, 'My Workspace');
  const suffix = randomUUID().slice(0, 8);
  const adminClient = createSupabaseAdminClient();
  const email = user.email ?? `${user.id}@supabase.invalid`;
  const name = profileName(user);

  const { data: existingByAuth, error: authLookupError } = await adminClient
    .from('users')
    .select('id, auth_user_id')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (authLookupError) {
    return NextResponse.json(
      { error: authLookupError.message },
      { status: 500 },
    );
  }

  let appUser = existingByAuth;

  /**
   * Whether this request is the one that created the app user row.
   *
   * This is the idempotency guard for `user_signed_up`. The API emits that
   * event from `supabase-auth.service.ts` when *it* provisions the user, so a
   * user who reached `/auth/me` before onboarding has already been counted.
   * Emitting again on every onboarding submission would inflate the signup
   * funnel and, on a repeat submission, count one person twice.
   */
  let createdAppUser = false;

  if (appUser) {
    const { error: profileUpdateError } = await adminClient
      .from('users')
      .update({ email, name })
      .eq('id', appUser.id);

    if (profileUpdateError) {
      return NextResponse.json({ error: profileUpdateError.message }, { status: 500 });
    }
  } else {
    const { data: existingByEmail, error: emailLookupError } = await adminClient
      .from('users')
      .select('id, auth_user_id')
      .eq('email', email)
      .maybeSingle();

    if (emailLookupError) {
      return NextResponse.json({ error: emailLookupError.message }, { status: 500 });
    }

    if (existingByEmail?.auth_user_id && existingByEmail.auth_user_id !== user.id) {
      return NextResponse.json(
        { error: 'Email is already linked to a different auth user' },
        { status: 409 },
      );
    }

    if (existingByEmail) {
      const { data: updatedUser, error: updateError } = await adminClient
        .from('users')
        .update({ auth_user_id: user.id, email, name })
        .eq('id', existingByEmail.id)
        .select('id, auth_user_id')
        .single();

      if (updateError || !updatedUser) {
        return NextResponse.json(
          { error: updateError?.message ?? 'Failed to link user profile' },
          { status: 500 },
        );
      }

      appUser = updatedUser;
    } else {
      const { data: insertedUser, error: insertError } = await adminClient
        .from('users')
        .insert({ auth_user_id: user.id, email, name })
        .select('id, auth_user_id')
        .single();

      if (insertError || !insertedUser) {
        return NextResponse.json(
          { error: insertError?.message ?? 'Failed to provision user profile' },
          { status: 500 },
        );
      }

      appUser = insertedUser;
      createdAppUser = true;
    }
  }

  // One organization per authenticated identity. The slug is derived from the
  // Supabase user id exactly as `provisionPersonalWorkspace` in
  // apps/api/src/auth/supabase-auth.service.ts derives it, so both provisioning
  // paths converge on the same row and the unique index on `organizations.slug`
  // is the cap — race-safe, unlike a count-then-insert check. A random suffix
  // here let one identity mint N organizations and draw N free monthly credit
  // allowances (one per organization). The name the user typed still wins: the
  // upsert applies it whether the row is new or was pre-provisioned as
  // 'Personal' by the API on first `GET /auth/me`.
  //
  // Same slug migration `provisionPersonalWorkspace` performs: releases before
  // the hash-based slug used `user-${supabaseUserId.slice(0, 8)}`. Without this
  // lookup the cap above is not a cap for those users — their organization sits
  // at the legacy slug, the upsert below finds no conflict, and they get a
  // second organization and a second free credit allowance, which is the defect
  // the cap exists to close.
  //
  // Ownership is verified because 8 hex characters collide far more readily than
  // the 24 the hash slug uses; matching on slug alone could attach this user to
  // another organization.
  const { data: legacyOrg, error: legacyOrgError } = await adminClient
    .from('organizations')
    .select('id')
    .eq('slug', legacyOrgSlug(user.id))
    .eq('owner_user_id', appUser.id)
    .maybeSingle();

  if (legacyOrgError) {
    return NextResponse.json({ error: legacyOrgError.message }, { status: 500 });
  }

  const { data: org, error: orgError } = legacyOrg
    ? await adminClient
        .from('organizations')
        .update({ name: orgName })
        .eq('id', legacyOrg.id)
        .select('id')
        .single()
    : await adminClient
        .from('organizations')
        .upsert(
          {
            name: orgName,
            slug: personalOrgSlug(user.id),
            owner_user_id: appUser.id,
            created_by_user_id: appUser.id,
          },
          { onConflict: 'slug' },
        )
        .select('id')
        .single();

  if (orgError || !org) {
    return NextResponse.json(
      { error: orgError?.message ?? 'Failed to create organization' },
      { status: 500 },
    );
  }

  // The organization is now shared with the API's provisioning path, so it may
  // already hold a workspace (the 'Demo Workspace' created on first
  // `GET /auth/me`). Reuse it under the name the user just typed instead of
  // stacking a second workspace on every onboarding submission.
  const { data: existingWorkspace, error: workspaceLookupError } = await adminClient
    .from('workspaces')
    .select('id')
    .eq('organization_id', org.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (workspaceLookupError) {
    return NextResponse.json({ error: workspaceLookupError.message }, { status: 500 });
  }

  const { data: workspace, error: wsError } = existingWorkspace
    ? await adminClient
        .from('workspaces')
        .update({ name: workspaceName })
        .eq('id', existingWorkspace.id)
        .select('id')
        .single()
    : await adminClient
        .from('workspaces')
        .insert({
          name: workspaceName,
          slug: `${slugify(workspaceName, 'workspace')}-${suffix}`,
          organization_id: org.id,
          type: 'direct',
        })
        .select('id')
        .single();

  if (wsError || !workspace) {
    return NextResponse.json(
      { error: wsError?.message ?? 'Failed to create workspace' },
      { status: 500 },
    );
  }

  const { error: memberError } = await adminClient
    .from('memberships')
    .upsert(
      {
        user_id: appUser.id,
        workspace_id: workspace.id,
        role: 'owner',
      },
      { onConflict: 'user_id,workspace_id' },
    );

  if (memberError) {
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  const { error: metadataError } = await adminClient.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...user.app_metadata,
      app_user_id: appUser.id,
      active_org_id: org.id,
      active_org_role: 'owner',
      active_workspace_id: workspace.id,
    },
  });

  if (metadataError) {
    return NextResponse.json({ error: metadataError.message }, { status: 500 });
  }

  // Schedule analytics after the response instead of adding its network timeout
  // to onboarding latency. Every write above has committed, so these events mean
  // "completed", and `after` keeps the work inside Next's request lifecycle.
  const analyticsContext = {
    workspaceId: workspace.id,
    organizationId: org.id,
    userId: appUser.id,
  };
  after(async () => {
    await Promise.all([
      ...(createdAppUser
        ? [
            captureServerEvent(
              'user_signed_up',
              { workspace_id: workspace.id },
              analyticsContext,
            ),
          ]
        : []),
      // Same idempotency reasoning as `user_signed_up`: a reused workspace was
      // already counted when whichever path created it did so.
      ...(existingWorkspace
        ? []
        : [
            captureServerEvent(
              'workspace_created',
              { workspace_id: workspace.id },
              analyticsContext,
            ),
          ]),
    ]);
  });

  return NextResponse.json({
    success: true,
    organizationId: org.id,
    workspaceId: workspace.id,
  });
}

function normalizeName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 120 ? trimmed : fallback;
}

/**
 * The one organization slug an authenticated identity can ever own.
 *
 * Must stay byte-identical to `provisionPersonalWorkspace` in
 * apps/api/src/auth/supabase-auth.service.ts: the two provisioning paths rely on
 * landing on the same row, and Postgres' unique index on `organizations.slug` is
 * what makes the cap race-safe.
 */
function personalOrgSlug(supabaseUserId: string): string {
  return `user-${createHash('sha256').update(supabaseUserId).digest('hex').slice(0, 24)}`;
}

/**
 * The pre-hash slug shape, kept only so an organization provisioned by an older
 * release is still found. Never write this shape.
 */
function legacyOrgSlug(supabaseUserId: string): string {
  return `user-${supabaseUserId.slice(0, 8)}`;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function profileName(user: { user_metadata?: Record<string, unknown> }): string | null {
  const fullName = user.user_metadata?.full_name;
  if (typeof fullName === 'string' && fullName.trim()) return fullName.trim();
  const name = user.user_metadata?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}
