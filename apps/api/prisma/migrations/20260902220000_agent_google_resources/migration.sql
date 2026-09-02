-- One Google Sheet per published agent. Created once at publish when the
-- workspace has Google connected; the header row is the agent's required_fields
-- keys after four fixed columns and is only ever appended to. Rows are written
-- live during calls by a queue worker; the call keeps its row number in
-- calls.metadata.sheet_row.
CREATE TABLE "agent_google_resources" (
  "id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "spreadsheet_id" TEXT NOT NULL,
  "spreadsheet_url" TEXT NOT NULL,
  "sheet_title" TEXT NOT NULL DEFAULT 'Calls',
  "columns" JSONB NOT NULL DEFAULT '[]',
  "header_synced_at" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_google_resources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_google_resources_agent_id_key" ON "agent_google_resources"("agent_id");
CREATE INDEX "agent_google_resources_workspace_id_idx" ON "agent_google_resources"("workspace_id");
ALTER TABLE "agent_google_resources"
  ADD CONSTRAINT "agent_google_resources_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data API exposure posture: SERVICE_ROLE_ONLY (apps/api/src/db/public-table-exposure-policy.ts).
-- Only the NestJS API and its worker touch this table; the dashboard sees the
-- sheet URL through the agent detail endpoint. Role guards keep the migration
-- working on databases without the Supabase Data API roles.
ALTER TABLE "agent_google_resources" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.agent_google_resources FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.agent_google_resources FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_google_resources TO service_role;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'agent_google_resources'
        AND policyname = 'agent_google_resources_service_role_all'
    ) THEN
      CREATE POLICY "agent_google_resources_service_role_all"
        ON public.agent_google_resources FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    END IF;
  END IF;
END $$;
