-- Migration 006: Supabase Auth schema additions
-- Adds the auth.users link, the org_invites table, the new
-- workspace_memberships unique key, and a trigger that auto-creates a
-- public.users row whenever a Supabase auth user is created.

-- ============================================================================
-- public.users: link to auth.users (Supabase GoTrue)
-- ============================================================================

alter table public.users
  add column if not exists auth_user_id uuid;

-- The reference is added as a unique index. We do NOT add a FK to
-- auth.users because that schema is owned by Supabase and may be locked
-- down in some hosting configs. The trigger below keeps the link in sync.
create unique index if not exists users_auth_user_id_key
  on public.users(auth_user_id)
  where auth_user_id is not null;

-- ============================================================================
-- public.organizations: track who created the org (audit aid)
-- ============================================================================

alter table public.organizations
  add column if not exists created_by_user_id uuid references public.users(id);

-- ============================================================================
-- public.workspace_memberships: new unique key without clerk_user_id
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspace_memberships_workspace_id_user_id_key'
  ) then
    alter table public.workspace_memberships
      add constraint workspace_memberships_workspace_id_user_id_key
      unique (workspace_id, user_id);
  end if;
end $$;

-- ============================================================================
-- public.org_invites: email invites into an organization
-- ============================================================================

create table if not exists public.org_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner','admin','member','viewer')),
  token text not null unique,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  invited_by_user_id uuid references public.users(id),
  created_at timestamptz default now()
);

create index if not exists org_invites_organization_id_idx on public.org_invites(organization_id);
create index if not exists org_invites_email_idx on public.org_invites(email);

-- ============================================================================
-- Trigger: when a row is inserted into auth.users, create the matching
-- public.users profile row. Org/workspace creation is handled in app code
-- (the onboarding flow), not here.
--
-- on conflict condition: only update if the existing user has no auth_user_id
-- linked OR if the email matches (handles re-signup with same email after
-- a deleted account). Never overwrites a different user's auth link.
-- ============================================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (auth_user_id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name')
  )
  on conflict (email) do update
    set
      auth_user_id = excluded.auth_user_id,
      name         = coalesce(excluded.name, public.users.name)
    where public.users.auth_user_id is null
       or public.users.email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ============================================================================
-- Helper to set the active_org_id claim on an auth user. Called by the
-- onboarding/org-switching flow (server-side, service role).
-- ============================================================================

create or replace function public.set_active_org(p_auth_user_id uuid, p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object('active_org_id', p_org_id::text)
    where id = p_auth_user_id;
end;
$$;

revoke all on function public.set_active_org(uuid, uuid) from public;
grant execute on function public.set_active_org(uuid, uuid) to service_role;
