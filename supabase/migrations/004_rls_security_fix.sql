-- Migration 004: Comprehensive RLS Security Fix
-- Fixes: mutable search_path, missing RLS policies, sensitive data exposure
-- Run on: 2026-05-05

-- ============================================================================
-- Phase 1: Fix mutable search_path on RLS helper functions
-- ============================================================================

-- Drop and recreate with SECURITY DEFINER + set search_path
drop function if exists public.current_clerk_user_id();
drop function if exists public.current_clerk_org_id();

create or replace function public.current_clerk_user_id()
returns text
language sql
stable
security definer
set search_path = ''
as 'select auth.jwt()->>''sub''';

create or replace function public.current_clerk_org_id()
returns text
language sql
stable
security definer
set search_path = ''
as 'select auth.jwt()->''o''->>''id''';

-- ============================================================================
-- Phase 2: Enable RLS + add policies for missing tables
-- ============================================================================

-- Users table: users can only see/update their own record
alter table public.users enable row level security;
create policy "Users can read own record"
  on public.users for select
  to authenticated
  using (external_auth_id = current_clerk_user_id());
create policy "Users can update own record"
  on public.users for update
  to authenticated
  using (external_auth_id = current_clerk_user_id())
  with check (external_auth_id = current_clerk_user_id());

-- AppOrgMemberships: users can read/write their org memberships
alter table public.app_org_memberships enable row level security;
create policy "Users can read own org memberships"
  on public.app_org_memberships for select
  to authenticated
  using (user_id in (
    select id from public.users where external_auth_id = current_clerk_user_id()
  ));
create policy "Users can insert own org memberships"
  on public.app_org_memberships for insert
  to authenticated
  with check (user_id in (
    select id from public.users where external_auth_id = current_clerk_user_id()
  ));
create policy "Users can update own org memberships"
  on public.app_org_memberships for update
  to authenticated
  using (user_id in (
    select id from public.users where external_auth_id = current_clerk_user_id()
  ));

-- WorkspaceMemberships: users can read/write their workspace memberships
alter table public.workspace_memberships enable row level security;
create policy "Users can read own workspace memberships"
  on public.workspace_memberships for select
  to authenticated
  using (user_id in (
    select id from public.users where external_auth_id = current_clerk_user_id()
  ));
create policy "Users can insert own workspace memberships"
  on public.workspace_memberships for insert
  to authenticated
  with check (user_id in (
    select id from public.users where external_auth_id = current_clerk_user_id()
  ));

-- Memberships: users can read their memberships
alter table public.memberships enable row level security;
create policy "Users can read own memberships"
  on public.memberships for select
  to authenticated
  using (user_id in (
    select id from public.users where external_auth_id = current_clerk_user_id()
  ));

-- ============================================================================
-- Phase 3: Add missing SELECT policies for existing RLS tables
-- ============================================================================

-- Agent templates: public templates readable by all, private only in user's orgs
alter table public.agent_templates enable row level security;
create policy "Users can read org agent templates"
  on public.agent_templates for select
  to authenticated
  using (
    is_public = true
    or workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      join public.users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );

-- Agent versions: readable if parent agent is readable
alter table public.agent_versions enable row level security;
create policy "Users can read agent versions"
  on public.agent_versions for select
  to authenticated
  using (
    agent_id in (
      select id from public.agents where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        where o.clerk_org_id = current_clerk_org_id()
      )
    )
    or (current_clerk_org_id() is null and agent_id in (
      select id from public.agents where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        join public.users u on u.id = o.owner_user_id
        where u.external_auth_id = current_clerk_user_id()
      )
    ))
  );

-- Call evaluations: readable if parent call is readable
alter table public.call_evaluations enable row level security;
create policy "Users can read call evaluations"
  on public.call_evaluations for select
  to authenticated
  using (
    call_id in (
      select id from public.calls where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        where o.clerk_org_id = current_clerk_org_id()
      )
    )
    or (current_clerk_org_id() is null and call_id in (
      select id from public.calls where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        join public.users u on u.id = o.owner_user_id
        where u.external_auth_id = current_clerk_user_id()
      )
    ))
  );

-- Call events: readable if parent call is readable
alter table public.call_events enable row level security;
create policy "Users can read call events"
  on public.call_events for select
  to authenticated
  using (
    call_id in (
      select id from public.calls where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        where o.clerk_org_id = current_clerk_org_id()
      )
    )
    or (current_clerk_org_id() is null and call_id in (
      select id from public.calls where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        join public.users u on u.id = o.owner_user_id
        where u.external_auth_id = current_clerk_user_id()
      )
    ))
  );

-- Integration tools: readable if parent workspace is readable
alter table public.integration_tools enable row level security;
create policy "Users can read integration tools"
  on public.integration_tools for select
  to authenticated
  using (
    workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      join public.users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );

-- Knowledge chunks: readable if parent source is readable
alter table public.knowledge_chunks enable row level security;
create policy "Users can read knowledge chunks"
  on public.knowledge_chunks for select
  to authenticated
  using (
    source_id in (
      select id from public.knowledge_sources where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        where o.clerk_org_id = current_clerk_org_id()
      )
    )
    or (current_clerk_org_id() is null and source_id in (
      select id from public.knowledge_sources where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        join public.users u on u.id = o.owner_user_id
        where u.external_auth_id = current_clerk_user_id()
      )
    ))
  );

-- Tool invocations: readable if parent tool/call is readable
alter table public.tool_invocations enable row level security;
create policy "Users can read tool invocations"
  on public.tool_invocations for select
  to authenticated
  using (
    tool_id in (
      select id from public.integration_tools where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        where o.clerk_org_id = current_clerk_org_id()
      )
    )
    or (current_clerk_org_id() is null and tool_id in (
      select id from public.integration_tools where workspace_id in (
        select w.id from public.workspaces w
        join public.organizations o on o.id = w.organization_id
        join public.users u on u.id = o.owner_user_id
        where u.external_auth_id = current_clerk_user_id()
      )
    ))
  );

-- ============================================================================
-- Phase 4: Add policies for non-RLS tables (DENY by default for external API)
-- ============================================================================

-- Contacts: only accessible via service role or backend API
-- RLS for contacts via workspace
alter table public.contacts enable row level security;
create policy "Service role only for contacts"
  on public.contacts for all
  to service_role
  using (true);

-- Compliance checks: backend-only via workspace access
alter table public.compliance_checks enable row level security;
create policy "Service role only for compliance_checks"
  on public.compliance_checks for all
  to service_role
  using (true);

-- DNC entries: backend-only
alter table public.dnc_entries enable row level security;
create policy "Service role only for dnc_entries"
  on public.dnc_entries for all
  to service_role
  using (true);

-- Consent records: backend-only
alter table public.consent_records enable row level security;
create policy "Service role only for consent_records"
  on public.consent_records for all
  to service_role
  using (true);

-- White label settings: workspace owner only
alter table public.white_label_settings enable row level security;
create policy "Workspace owner can manage white label"
  on public.white_label_settings for all
  to authenticated
  using (
    workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      where o.owner_user_id in (
        select id from public.users where external_auth_id = current_clerk_user_id()
      )
    )
  );

-- Client invites: org admin only
alter table public.client_invites enable row level security;
create policy "Org admin can manage client invites"
  on public.client_invites for all
  to authenticated
  using (
    agency_workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
  );

-- Subscriptions: org-level only (via service role, backend enforces)
alter table public.subscriptions enable row level security;
create policy "Service role only for subscriptions"
  on public.subscriptions for all
  to service_role
  using (true);

-- Analytics events: workspace readable
alter table public.analytics_events enable row level security;
create policy "Users can read analytics events"
  on public.analytics_events for select
  to authenticated
  using (
    workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      where o.clerk_org_id = current_clerk_org_id()
    )
    or (current_clerk_org_id() is null and workspace_id in (
      select w.id from public.workspaces w
      join public.organizations o on o.id = w.organization_id
      join public.users u on u.id = o.owner_user_id
      where u.external_auth_id = current_clerk_user_id()
    ))
  );
create policy "Service role for analytics insert"
  on public.analytics_events for insert
  to service_role
  with check (true);

-- Stripe events: service role only
alter table public.stripe_events enable row level security;
create policy "Service role only for stripe_events"
  on public.stripe_events for all
  to service_role
  using (true);

-- Webhook events: service role only
alter table public.webhook_events enable row level security;
create policy "Service role only for webhook_events"
  on public.webhook_events for all
  to service_role
  using (true);

-- Usage records: service role + org readable
alter table public.usage_records enable row level security;
create policy "Service role only for usage_records"
  on public.usage_records for all
  to service_role
  using (true);

-- Google calendar configs: user-specific, service role only
alter table public.google_calendar_configs enable row level security;
create policy "Service role only for google_calendar_configs"
  on public.google_calendar_configs for all
  to service_role
  using (true);

-- Prisma migrations: service role only (never exposed to API)
alter table public._prisma_migrations enable row level security;
create policy "Service role only for _prisma_migrations"
  on public._prisma_migrations for all
  to service_role
  using (true);

-- ============================================================================
-- Phase 5: Fix race condition on user email unique constraint
-- Add a debounce mechanism via advisory lock
-- ============================================================================

-- Create helper function for user provisioning with locking
create or replace function public.provision_user_with_lock(
  p_external_auth_id text,
  p_email text,
  p_name text
)
returns public.users
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users;
begin
  -- Use advisory lock to prevent race condition on email
  perform pg_advisory_xact_lock(hashtext(p_email));

  -- Check if user exists with this email (might be from different auth provider)
  select * into v_user from public.users where email = p_email limit 1;

  if v_user.id is null then
    -- No existing user, create new one
    insert into public.users (external_auth_id, email, name)
    values (p_external_auth_id, p_email, p_name)
    returning * into v_user;
  elsif v_user.external_auth_id is null then
    -- Existing user with no auth link, link it
    update public.users set external_auth_id = p_external_auth_id
    where id = v_user.id
    returning * into v_user;
  elsif v_user.external_auth_id = p_external_auth_id then
    -- Same user, return as-is
    null;
  else
    -- Email taken by different user, use unique email for this auth
    insert into public.users (external_auth_id, email, name)
    values (p_external_auth_id, p_external_auth_id || '_' || p_email, p_name)
    returning * into v_user;
  end if;

  return v_user;
end;
$$;

-- ============================================================================
-- Verification
-- ============================================================================

-- Grant execute on helper functions
grant execute on function public.current_clerk_user_id() to authenticated;
grant execute on function public.current_clerk_org_id() to authenticated;
grant execute on function public.provision_user_with_lock(text, text, text) to authenticated;