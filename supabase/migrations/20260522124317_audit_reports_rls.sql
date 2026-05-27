-- Fix Supabase Security Advisor alert: public.audit_reports had no RLS.
-- The table stores signed audit report tokens and truncated report content,
-- so direct anon/authenticated API access must remain denied.

do $$
begin
  if to_regclass('public.audit_reports') is not null then
    execute 'alter table public.audit_reports enable row level security';

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'audit_reports'
        and policyname = 'audit_reports_service_role_all'
    ) then
      execute '
        create policy "audit_reports_service_role_all"
          on public.audit_reports
          for all
          to service_role
          using (true)
          with check (true)
      ';
    end if;
  end if;
end $$;
