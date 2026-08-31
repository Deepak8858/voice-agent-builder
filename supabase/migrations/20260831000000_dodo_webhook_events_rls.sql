-- Follow `stripe_events` -> `dodo_webhook_events` (Prisma migration
-- 20260831000000_dodo_payments_provider_swap) on the hand-applied Supabase track.
--
-- Renaming a table in Postgres keeps RLS enabled and keeps every policy attached,
-- so the table is never exposed in between the two migrations. What does not
-- follow is the policy NAMES: three earlier migrations created Stripe-named
-- policies on this table (004, 008, 20260529121336), and the guard in
-- 20260531131801 plus `db-enable-rls`/`db-verify` derive the expected policy name
-- from the table name. Left alone, this table would read as unpoliced.

alter table if exists public.dodo_webhook_events enable row level security;

do $$
begin
  if to_regclass('public.dodo_webhook_events') is null then
    return;
  end if;

  drop policy if exists "Service role only for stripe_events" on public.dodo_webhook_events;
  drop policy if exists "stripe_events_service_role_all" on public.dodo_webhook_events;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'dodo_webhook_events'
      and policyname = 'dodo_webhook_events_service_role_all'
  ) then
    create policy "dodo_webhook_events_service_role_all"
      on public.dodo_webhook_events for all to service_role
      using (true) with check (true);
  end if;
end $$;

-- No grants are re-issued: 20260529121336 revoked table DML from anon,
-- authenticated AND service_role, and a rename carries privileges with it, so the
-- renamed table is still unreachable through the Data API.
