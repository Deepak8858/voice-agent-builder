-- Data API exposure posture for google_oauth_connections. The table is listed
-- in SERVICE_ROLE_ONLY_TABLES (apps/api/src/db/public-table-exposure-policy.ts):
-- it stores encrypted OAuth token material and only the NestJS API reads or
-- writes it, so anon and authenticated get no grants while service_role gets
-- full CRUD. The original 20260822000000_google_oauth_connection migration
-- enabled RLS and created the defense-in-depth workspace policies but omitted
-- this block, which db-verify flags as MISSING_GRANT. It ships as a separate
-- migration because the original one is already applied in production.
-- The role guard keeps the migration working on databases without Supabase
-- Data API roles.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.google_oauth_connections FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.google_oauth_connections FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.google_oauth_connections TO service_role;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'google_oauth_connections'
        AND policyname = 'google_oauth_connections_service_role_all'
    ) THEN
      CREATE POLICY "google_oauth_connections_service_role_all"
        ON public.google_oauth_connections FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    END IF;
  END IF;
END $$;
