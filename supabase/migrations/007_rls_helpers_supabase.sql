-- Migration 007: RLS helpers for Supabase Auth
-- Replaces the Clerk helpers from 002/004 with Supabase-Auth-aware versions.
--   current_user_id()      -> auth.uid()
--   current_app_user_id()  -> public.users.id for the current auth user
--   current_org_id()       -> active_org_id from app_metadata claim

create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as 'select auth.uid()';

create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.users where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(
    coalesce(
      auth.jwt() -> 'app_metadata' ->> 'active_org_id',
      auth.jwt() ->> 'active_org_id'
    ),
    ''
  )::uuid
$$;

grant execute on function public.current_user_id() to authenticated;
grant execute on function public.current_app_user_id() to authenticated;
grant execute on function public.current_org_id() to authenticated;
