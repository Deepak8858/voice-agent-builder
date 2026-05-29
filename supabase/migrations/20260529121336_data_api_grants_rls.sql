-- Harden Supabase Data API exposure for the May 30, 2026 default-grant change.
--
-- Principle:
--   * anon has no direct table access in public.
--   * authenticated can SELECT only tables with tenant-scoped RLS read policies.
--   * service_role can use the Data API for trusted server-side code.
--   * every known public table has RLS enabled, even if it is backend-only.

revoke select, insert, update, delete on all tables in schema public
  from anon, authenticated, service_role;

revoke usage, select on all sequences in schema public
  from anon, authenticated, service_role;

revoke execute on all functions in schema public
  from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions
  from public, anon, authenticated, service_role;

do $$
declare
  table_name text;
  known_tables text[] := array[
    'users',
    'organizations',
    'workspaces',
    'memberships',
    'workspace_memberships',
    'org_invites',
    'agents',
    'agent_versions',
    'agent_templates',
    'knowledge_sources',
    'knowledge_chunks',
    'calls',
    'call_events',
    'call_evaluations',
    'audit_logs',
    'integration_tools',
    'tool_invocations',
    'analytics_events',
    'client_invites',
    'white_label_settings',
    'workspace_crm_credentials',
    'crm_routing_rules',
    'crm_fanout_log',
    'twilio_phone_numbers',
    'outbound_campaigns',
    'telephony_provider_connections',
    'telephony_phone_numbers',
    'livekit_telephony_configs',
    'telephony_webhook_events',
    'contacts',
    'consent_records',
    'dnc_entries',
    'compliance_checks',
    'audit_reports',
    'subscriptions',
    'usage_records',
    'stripe_events',
    'webhook_events',
    'google_calendar_configs',
    'referrals',
    '_prisma_migrations',
    'app_org_memberships',
    'alerts',
    'plan_pricing',
    'call_messages',
    'compliance_logs',
    'tool_definitions',
    'billing_events'
  ];
begin
  foreach table_name in array known_tables loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format(
        'grant select, insert, update, delete on table public.%I to service_role',
        table_name
      );
    end if;
  end loop;
end $$;

do $$
declare
  table_name text;
  authenticated_read_tables text[] := array[
    'users',
    'organizations',
    'workspaces',
    'memberships',
    'workspace_memberships',
    'org_invites',
    'agents',
    'agent_versions',
    'agent_templates',
    'knowledge_sources',
    'knowledge_chunks',
    'calls',
    'call_events',
    'call_evaluations',
    'audit_logs',
    'integration_tools',
    'tool_invocations',
    'analytics_events',
    'client_invites',
    'white_label_settings',
    'workspace_crm_credentials',
    'crm_routing_rules',
    'crm_fanout_log',
    'twilio_phone_numbers',
    'outbound_campaigns',
    'telephony_provider_connections',
    'telephony_phone_numbers',
    'livekit_telephony_configs',
    'telephony_webhook_events'
  ];
begin
  foreach table_name in array authenticated_read_tables loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('grant select on table public.%I to authenticated', table_name);
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema public to service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;

grant execute on all functions in schema public to service_role;
grant execute on function public.current_user_id() to authenticated;
grant execute on function public.current_app_user_id() to authenticated;
grant execute on function public.current_org_id() to authenticated;
grant execute on function public.set_active_org(uuid, uuid) to service_role;

-- Backend-only tables get an explicit service_role policy for auditability.
do $$
declare
  table_name text;
  policy_name text;
  backend_only_tables text[] := array[
    'contacts',
    'consent_records',
    'dnc_entries',
    'compliance_checks',
    'audit_reports',
    'subscriptions',
    'usage_records',
    'stripe_events',
    'webhook_events',
    'google_calendar_configs',
    'referrals',
    '_prisma_migrations',
    'app_org_memberships',
    'alerts',
    'plan_pricing',
    'call_messages',
    'compliance_logs',
    'tool_definitions',
    'billing_events'
  ];
begin
  foreach table_name in array backend_only_tables loop
    if to_regclass(format('public.%I', table_name)) is not null then
      policy_name := table_name || '_service_role_all';

      if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = table_name
          and policyname = policy_name
      ) then
        execute format(
          'create policy %I on public.%I for all to service_role using (true) with check (true)',
          policy_name,
          table_name
        );
      end if;
    end if;
  end loop;
end $$;

-- Older Prisma-side migrations created these policies without an explicit TO
-- clause. Recreate them with explicit authenticated/service_role scope.
do $$
begin
  if to_regclass('public.workspace_crm_credentials') is not null then
    drop policy if exists "workspace_crm_credentials_workspace_read"
      on public.workspace_crm_credentials;
    drop policy if exists "workspace_crm_credentials_workspace_write"
      on public.workspace_crm_credentials;

    create policy "workspace_crm_credentials_workspace_read"
      on public.workspace_crm_credentials for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "workspace_crm_credentials_workspace_write"
      on public.workspace_crm_credentials for all
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      )
      with check (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      );
  end if;

  if to_regclass('public.crm_routing_rules') is not null then
    drop policy if exists "crm_routing_rules_workspace_read"
      on public.crm_routing_rules;
    drop policy if exists "crm_routing_rules_workspace_write"
      on public.crm_routing_rules;

    create policy "crm_routing_rules_workspace_read"
      on public.crm_routing_rules for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "crm_routing_rules_workspace_write"
      on public.crm_routing_rules for all
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      )
      with check (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      );
  end if;

  if to_regclass('public.twilio_phone_numbers') is not null then
    drop policy if exists "twilio_phone_numbers_workspace_read"
      on public.twilio_phone_numbers;
    drop policy if exists "twilio_phone_numbers_workspace_write"
      on public.twilio_phone_numbers;

    create policy "twilio_phone_numbers_workspace_read"
      on public.twilio_phone_numbers for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "twilio_phone_numbers_workspace_write"
      on public.twilio_phone_numbers for all
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      )
      with check (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      );
  end if;

  if to_regclass('public.outbound_campaigns') is not null then
    drop policy if exists "outbound_campaigns_workspace_read"
      on public.outbound_campaigns;
    drop policy if exists "outbound_campaigns_workspace_write"
      on public.outbound_campaigns;

    create policy "outbound_campaigns_workspace_read"
      on public.outbound_campaigns for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "outbound_campaigns_workspace_write"
      on public.outbound_campaigns for all
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      )
      with check (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      );
  end if;

  if to_regclass('public.crm_fanout_log') is not null then
    drop policy if exists "crm_fanout_log_workspace_read"
      on public.crm_fanout_log;
    drop policy if exists "crm_fanout_log_insert"
      on public.crm_fanout_log;

    create policy "crm_fanout_log_workspace_read"
      on public.crm_fanout_log for select
      to authenticated
      using (
        agent_id in (
          select a.id
          from public.agents a
          join public.workspace_memberships wm on wm.workspace_id = a.workspace_id
          where wm.user_id = public.current_app_user_id()
        )
        or call_id in (
          select c.id
          from public.calls c
          join public.workspace_memberships wm on wm.workspace_id = c.workspace_id
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "crm_fanout_log_insert"
      on public.crm_fanout_log for insert
      to service_role
      with check (true);
  end if;
end $$;

do $$
begin
  if to_regclass('public.telephony_provider_connections') is not null then
    drop policy if exists "telephony_provider_connections_workspace_read"
      on public.telephony_provider_connections;
    drop policy if exists "telephony_provider_connections_workspace_write"
      on public.telephony_provider_connections;

    create policy "telephony_provider_connections_workspace_read"
      on public.telephony_provider_connections for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "telephony_provider_connections_workspace_write"
      on public.telephony_provider_connections for all
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      )
      with check (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      );
  end if;

  if to_regclass('public.telephony_phone_numbers') is not null then
    drop policy if exists "telephony_phone_numbers_workspace_read"
      on public.telephony_phone_numbers;
    drop policy if exists "telephony_phone_numbers_workspace_write"
      on public.telephony_phone_numbers;

    create policy "telephony_phone_numbers_workspace_read"
      on public.telephony_phone_numbers for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "telephony_phone_numbers_workspace_write"
      on public.telephony_phone_numbers for all
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      )
      with check (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      );
  end if;

  if to_regclass('public.livekit_telephony_configs') is not null then
    drop policy if exists "livekit_telephony_configs_workspace_read"
      on public.livekit_telephony_configs;
    drop policy if exists "livekit_telephony_configs_workspace_write"
      on public.livekit_telephony_configs;

    create policy "livekit_telephony_configs_workspace_read"
      on public.livekit_telephony_configs for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "livekit_telephony_configs_workspace_write"
      on public.livekit_telephony_configs for all
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      )
      with check (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
            and wm.role in ('owner', 'admin', 'editor')
        )
      );
  end if;

  if to_regclass('public.telephony_webhook_events') is not null then
    drop policy if exists "telephony_webhook_events_workspace_read"
      on public.telephony_webhook_events;
    drop policy if exists "telephony_webhook_events_insert"
      on public.telephony_webhook_events;

    create policy "telephony_webhook_events_workspace_read"
      on public.telephony_webhook_events for select
      to authenticated
      using (
        workspace_id in (
          select wm.workspace_id
          from public.workspace_memberships wm
          where wm.user_id = public.current_app_user_id()
        )
      );

    create policy "telephony_webhook_events_insert"
      on public.telephony_webhook_events for insert
      to service_role
      with check (true);
  end if;
end $$;

notify pgrst, 'reload schema';
