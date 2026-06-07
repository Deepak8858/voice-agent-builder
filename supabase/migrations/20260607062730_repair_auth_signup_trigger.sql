-- Repair Supabase Auth signup provisioning.
--
-- Production still had the older auth.users trigger wired to
-- public.handle_new_user(), which only handled conflicts on public.users.id.
-- Re-signing up an email already present in public.users therefore hit the
-- users_email_key constraint and surfaced as "Database error saving new user".

create extension if not exists pgcrypto with schema extensions;

alter table public.users
  alter column id set default gen_random_uuid();

alter table public.users
  add column if not exists auth_user_id uuid;

create unique index if not exists users_auth_user_id_key
  on public.users(auth_user_id)
  where auth_user_id is not null;

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
      name = coalesce(excluded.name, public.users.name)
    where public.users.auth_user_id is null
       or public.users.auth_user_id = excluded.auth_user_id
       or public.users.email = excluded.email;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.handle_new_auth_user() from anon;
revoke all on function public.handle_new_auth_user() from authenticated;
grant execute on function public.handle_new_auth_user() to supabase_auth_admin;

drop function if exists public.handle_new_user();
