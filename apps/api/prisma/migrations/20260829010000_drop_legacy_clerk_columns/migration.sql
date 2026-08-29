-- Drop the last Clerk-era identity columns. Supabase Auth replaced Clerk; see
-- `supabase/migrations/005_drop_clerk.sql`.
--
-- This is a promotion, not new work. The same DDL has been sitting in
-- `apps/api/prisma/migrations/0037_drop_legacy_clerk_columns.sql` as a BARE .sql
-- file at the migrations root, and `prisma migrate deploy` only applies
-- `<name>/migration.sql` directories — so it never ran. That is why the deployed
-- `organizations` table still carries `clerk_org_id` and two indexes the Prisma
-- schema does not model: a live column no code reads, invisible to
-- `prisma migrate status`.
--
-- Every statement is `IF EXISTS`, so this is a no-op on a database where the
-- columns were already dropped by hand or by the Supabase migration. It is safe
-- to run against production without checking first.

-- Supabase Auth's user id. Added here because the same bare file added it, and a
-- database that never ran that file needs the column before the unique index.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_key
  ON public.users(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Clerk's user id on users.
DROP INDEX IF EXISTS public.users_external_auth_id_key;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS external_auth_id;

-- Clerk's organization id. The index is dropped first: dropping the column would
-- take it with it, but naming it makes the intent explicit for a database where
-- the column is already gone and only a stray index remains.
DROP INDEX IF EXISTS public.organizations_clerk_org_id_key;

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS clerk_org_id;

-- Clerk's user id on workspace memberships. The composite unique constraint
-- referencing it must go before the column.
ALTER TABLE public.workspace_memberships
  DROP CONSTRAINT IF EXISTS workspace_memberships_workspace_id_clerk_user_id_key;

DROP INDEX IF EXISTS public.workspace_memberships_clerk_user_id_idx;

ALTER TABLE public.workspace_memberships
  DROP COLUMN IF EXISTS clerk_user_id;
