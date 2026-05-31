-- Close the live Supabase Security Advisor rls_disabled_in_public finding.
--
-- The May 27, 2026 unread advisor email did not include table names, but the
-- live db-verify run identified public.alerts and public.plan_pricing with RLS
-- disabled. Both are backend-only legacy tables in the repo exposure policy.

do $$
declare
  table_name text;
  backend_only_tables text[] := array[
    'alerts',
    'plan_pricing'
  ];
begin
  foreach table_name in array backend_only_tables loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format(
        'revoke select, insert, update, delete on table public.%I from anon, authenticated',
        table_name
      );
      execute format(
        'grant select, insert, update, delete on table public.%I to service_role',
        table_name
      );
      execute format('alter table public.%I enable row level security', table_name);

      if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = table_name
          and policyname = table_name || '_service_role_all'
      ) then
        execute format(
          'create policy %I on public.%I for all to service_role using (true) with check (true)',
          table_name || '_service_role_all',
          table_name
        );
      end if;
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.agent_templates') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_templates'
      and policyname = 'agent_templates_select_public_or_active_org'
  ) then
    create policy "agent_templates_select_public_or_active_org"
      on public.agent_templates for select
      to authenticated
      using (is_public = true or organization_id = public.current_org_id());
  end if;

  if to_regclass('public.agent_versions') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_versions'
      and policyname = 'agent_versions_select_active_org'
  ) then
    create policy "agent_versions_select_active_org"
      on public.agent_versions for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.analytics_events') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'analytics_events'
      and policyname = 'analytics_events_select_active_org'
  ) then
    create policy "analytics_events_select_active_org"
      on public.analytics_events for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.call_evaluations') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'call_evaluations'
      and policyname = 'call_evaluations_select_active_org'
  ) then
    create policy "call_evaluations_select_active_org"
      on public.call_evaluations for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.call_events') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'call_events'
      and policyname = 'call_events_select_active_org'
  ) then
    create policy "call_events_select_active_org"
      on public.call_events for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.client_invites') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'client_invites'
      and policyname = 'client_invites_select_active_org'
  ) then
    create policy "client_invites_select_active_org"
      on public.client_invites for select
      to authenticated
      using (
        agency_workspace_id in (
          select id
          from public.workspaces
          where organization_id = public.current_org_id()
        )
      );
  end if;

  if to_regclass('public.integration_tools') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'integration_tools'
      and policyname = 'integration_tools_select_active_org'
  ) then
    create policy "integration_tools_select_active_org"
      on public.integration_tools for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.knowledge_chunks') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'knowledge_chunks'
      and policyname = 'knowledge_chunks_select_active_org'
  ) then
    create policy "knowledge_chunks_select_active_org"
      on public.knowledge_chunks for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.org_invites') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'org_invites'
      and policyname = 'org_invites_select_org_member'
  ) then
    create policy "org_invites_select_org_member"
      on public.org_invites for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.tool_invocations') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tool_invocations'
      and policyname = 'tool_invocations_select_active_org'
  ) then
    create policy "tool_invocations_select_active_org"
      on public.tool_invocations for select
      to authenticated
      using (organization_id = public.current_org_id());
  end if;

  if to_regclass('public.white_label_settings') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'white_label_settings'
      and policyname = 'white_label_settings_select_active_org'
  ) then
    create policy "white_label_settings_select_active_org"
      on public.white_label_settings for select
      to authenticated
      using (
        workspace_id in (
          select id
          from public.workspaces
          where organization_id = public.current_org_id()
        )
      );
  end if;

  if to_regclass('public.workspace_memberships') is not null and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'workspace_memberships'
      and policyname = 'workspace_memberships_select_self'
  ) then
    create policy "workspace_memberships_select_self"
      on public.workspace_memberships for select
      to authenticated
      using (user_id = public.current_app_user_id());
  end if;
end $$;

do $$
declare
  disabled_tables text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), array[]::text[])
  into disabled_tables
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity
    and not exists (
      select 1
      from pg_inherits i
      where i.inhrelid = c.oid
    );

  if array_length(disabled_tables, 1) is not null then
    raise exception 'public tables with RLS disabled: %', disabled_tables;
  end if;
end $$;

notify pgrst, 'reload schema';
