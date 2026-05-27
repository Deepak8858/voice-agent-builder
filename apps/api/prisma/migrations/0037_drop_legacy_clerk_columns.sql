-- Align Prisma-managed databases with the Supabase Auth migration path.
-- These columns were part of the original Clerk-era schema and are no longer
-- used by the application auth flow.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_key
  ON public.users(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

DROP INDEX IF EXISTS public.users_external_auth_id_key;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS external_auth_id;

DROP INDEX IF EXISTS public.organizations_clerk_org_id_key;

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS clerk_org_id;

ALTER TABLE public.workspace_memberships
  DROP CONSTRAINT IF EXISTS workspace_memberships_workspace_id_clerk_user_id_key;

DROP INDEX IF EXISTS public.workspace_memberships_clerk_user_id_idx;

ALTER TABLE public.workspace_memberships
  DROP COLUMN IF EXISTS clerk_user_id;
