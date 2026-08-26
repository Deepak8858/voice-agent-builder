-- Unified Google Workspace OAuth connection: one encrypted token set with
-- granted scopes per workspace, plus reauth-state tracking.

CREATE TABLE IF NOT EXISTS "google_oauth_connections" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "access_token" TEXT NOT NULL,
  "refresh_token" TEXT NOT NULL,
  "token_expiry" TIMESTAMP(3) NOT NULL,
  "scopes" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'connected',
  "last_verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "google_oauth_connections_workspace_id_key" UNIQUE ("workspace_id")
);

-- The UNIQUE constraint on workspace_id already provides that index; only the
-- organization lookup needs an explicit one.
CREATE INDEX IF NOT EXISTS "google_oauth_connections_organization_id_idx" ON "google_oauth_connections"("organization_id");

ALTER TABLE "google_oauth_connections" ENABLE ROW LEVEL SECURITY;

-- Both policies are restricted to owner/admin/editor: this table stores
-- encrypted OAuth token material, which viewers have no reason to read.
-- Policy creation is guarded so the migration replays cleanly on databases
-- where the policies were already created by hand or by an earlier run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'google_oauth_connections'
      AND policyname = 'google_oauth_connections_workspace_read'
  ) THEN
    CREATE POLICY "google_oauth_connections_workspace_read"
      ON public.google_oauth_connections FOR SELECT
      USING (workspace_id IN (
        SELECT w.id FROM public.workspaces w
        JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
        JOIN public.users u ON u.id = wm.user_id
        WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
        AND wm.role IN ('owner', 'admin', 'editor')
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'google_oauth_connections'
      AND policyname = 'google_oauth_connections_workspace_write'
  ) THEN
    CREATE POLICY "google_oauth_connections_workspace_write"
      ON public.google_oauth_connections FOR ALL
      USING (workspace_id IN (
        SELECT w.id FROM public.workspaces w
        JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
        JOIN public.users u ON u.id = wm.user_id
        WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
        AND wm.role IN ('owner', 'admin', 'editor')
      ))
      WITH CHECK (workspace_id IN (
        SELECT w.id FROM public.workspaces w
        JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
        JOIN public.users u ON u.id = wm.user_id
        WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
        AND wm.role IN ('owner', 'admin', 'editor')
      ));
  END IF;
END $$;
