-- Migration 008: RLS policies aligned with Supabase Auth
-- Tenancy: every customer-owned table is scoped by organization_id.
-- Pattern: row visible if its organization_id matches current_org_id()
-- AND the calling app user has a membership in that org's workspaces.
-- Service role bypasses RLS for backend writes (NestJS, webhooks).

-- ============================================================================
-- users: each auth user can read/update their own public.users row
-- ============================================================================

alter table public.users enable row level security;

create policy "users_select_self"
  on public.users for select
  to authenticated
  using (auth_user_id = auth.uid());

create policy "users_update_self"
  on public.users for update
  to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- ============================================================================
-- organizations: members can read; owner can update/delete
-- ============================================================================

alter table public.organizations enable row level security;

create policy "organizations_select_member"
  on public.organizations for select
  to authenticated
  using (
    id = public.current_org_id()
    or owner_user_id = public.current_app_user_id()
    or exists (
      select 1
      from public.memberships m
      join public.workspaces w on w.id = m.workspace_id
      where w.organization_id = public.organizations.id
        and m.user_id = public.current_app_user_id()
    )
  );

create policy "organizations_update_owner"
  on public.organizations for update
  to authenticated
  using (owner_user_id = public.current_app_user_id())
  with check (owner_user_id = public.current_app_user_id());

create policy "organizations_insert_self"
  on public.organizations for insert
  to authenticated
  with check (owner_user_id = public.current_app_user_id());

create policy "organizations_delete_owner"
  on public.organizations for delete
  to authenticated
  using (owner_user_id = public.current_app_user_id());

-- ============================================================================
-- workspaces: visible to org members
-- ============================================================================

alter table public.workspaces enable row level security;

create policy "workspaces_select_member"
  on public.workspaces for select
  to authenticated
  using (
    organization_id = public.current_org_id()
    or exists (
      select 1
      from public.memberships m
      where m.workspace_id = public.workspaces.id
        and m.user_id = public.current_app_user_id()
    )
  );

create policy "workspaces_write_org_member"
  on public.workspaces for all
  to authenticated
  using (organization_id = public.current_org_id())
  with check (organization_id = public.current_org_id());

-- ============================================================================
-- memberships: each user reads their own
-- ============================================================================

alter table public.memberships enable row level security;

create policy "memberships_select_self"
  on public.memberships for select
  to authenticated
  using (user_id = public.current_app_user_id());

-- ============================================================================
-- workspace_memberships: each user reads their own
-- ============================================================================

alter table public.workspace_memberships enable row level security;

create policy "workspace_memberships_select_self"
  on public.workspace_memberships for select
  to authenticated
  using (user_id = public.current_app_user_id());

-- ============================================================================
-- org_invites: org members can read invites for their org
-- ============================================================================

alter table public.org_invites enable row level security;

create policy "org_invites_select_org_member"
  on public.org_invites for select
  to authenticated
  using (organization_id = public.current_org_id());

-- ============================================================================
-- Generic per-org-id read policy (re-used helper)
-- We open SELECT to authenticated users where organization_id matches
-- the active org claim. Writes go through the service role from NestJS.
-- ============================================================================

-- agents
alter table public.agents enable row level security;
create policy "agents_select_active_org"
  on public.agents for select
  to authenticated
  using (organization_id = public.current_org_id());

-- agent_versions
alter table public.agent_versions enable row level security;
create policy "agent_versions_select_active_org"
  on public.agent_versions for select
  to authenticated
  using (organization_id = public.current_org_id());

-- agent_templates
alter table public.agent_templates enable row level security;
create policy "agent_templates_select_public_or_active_org"
  on public.agent_templates for select
  to authenticated
  using (is_public = true or organization_id = public.current_org_id());

-- knowledge_sources
alter table public.knowledge_sources enable row level security;
create policy "knowledge_sources_select_active_org"
  on public.knowledge_sources for select
  to authenticated
  using (organization_id = public.current_org_id());

-- knowledge_chunks
alter table public.knowledge_chunks enable row level security;
create policy "knowledge_chunks_select_active_org"
  on public.knowledge_chunks for select
  to authenticated
  using (organization_id = public.current_org_id());

-- calls
alter table public.calls enable row level security;
create policy "calls_select_active_org"
  on public.calls for select
  to authenticated
  using (organization_id = public.current_org_id());

-- call_events
alter table public.call_events enable row level security;
create policy "call_events_select_active_org"
  on public.call_events for select
  to authenticated
  using (organization_id = public.current_org_id());

-- call_evaluations
alter table public.call_evaluations enable row level security;
create policy "call_evaluations_select_active_org"
  on public.call_evaluations for select
  to authenticated
  using (organization_id = public.current_org_id());

-- audit_logs
alter table public.audit_logs enable row level security;
create policy "audit_logs_select_active_org"
  on public.audit_logs for select
  to authenticated
  using (organization_id = public.current_org_id());

-- integration_tools
alter table public.integration_tools enable row level security;
create policy "integration_tools_select_active_org"
  on public.integration_tools for select
  to authenticated
  using (organization_id = public.current_org_id());

-- tool_invocations
alter table public.tool_invocations enable row level security;
create policy "tool_invocations_select_active_org"
  on public.tool_invocations for select
  to authenticated
  using (organization_id = public.current_org_id());

-- analytics_events
alter table public.analytics_events enable row level security;
create policy "analytics_events_select_active_org"
  on public.analytics_events for select
  to authenticated
  using (organization_id = public.current_org_id());

-- ============================================================================
-- Tables that must remain backend-only (service role).  We enable RLS so
-- authenticated clients see nothing, then add an explicit service_role-all
-- policy for backend writes.
-- ============================================================================

alter table public.contacts enable row level security;
create policy "contacts_service_role_all"
  on public.contacts for all to service_role using (true) with check (true);

alter table public.consent_records enable row level security;
create policy "consent_records_service_role_all"
  on public.consent_records for all to service_role using (true) with check (true);

alter table public.dnc_entries enable row level security;
create policy "dnc_entries_service_role_all"
  on public.dnc_entries for all to service_role using (true) with check (true);

alter table public.compliance_checks enable row level security;
create policy "compliance_checks_service_role_all"
  on public.compliance_checks for all to service_role using (true) with check (true);

alter table public.subscriptions enable row level security;
create policy "subscriptions_service_role_all"
  on public.subscriptions for all to service_role using (true) with check (true);

alter table public.usage_records enable row level security;
create policy "usage_records_service_role_all"
  on public.usage_records for all to service_role using (true) with check (true);

alter table public.stripe_events enable row level security;
create policy "stripe_events_service_role_all"
  on public.stripe_events for all to service_role using (true) with check (true);

alter table public.webhook_events enable row level security;
create policy "webhook_events_service_role_all"
  on public.webhook_events for all to service_role using (true) with check (true);

alter table public.google_calendar_configs enable row level security;
create policy "google_calendar_configs_service_role_all"
  on public.google_calendar_configs for all to service_role using (true) with check (true);

alter table public.client_invites enable row level security;
create policy "client_invites_select_active_org"
  on public.client_invites for select
  to authenticated
  using (
    agency_workspace_id in (
      select id from public.workspaces where organization_id = public.current_org_id()
    )
  );
create policy "client_invites_service_role_all"
  on public.client_invites for all to service_role using (true) with check (true);

alter table public.white_label_settings enable row level security;
create policy "white_label_settings_select_active_org"
  on public.white_label_settings for select
  to authenticated
  using (
    workspace_id in (
      select id from public.workspaces where organization_id = public.current_org_id()
    )
  );
create policy "white_label_settings_service_role_all"
  on public.white_label_settings for all to service_role using (true) with check (true);
