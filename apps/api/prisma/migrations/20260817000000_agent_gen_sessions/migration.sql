-- agent_gen_sessions backs the chat-to-agent generation flow. It shipped as a
-- bare `prisma/migrations/0038_agent_gen_sessions.sql` file, which
-- `prisma migrate deploy` never applies: Prisma only executes migrations stored
-- as `<timestamp>_<name>/migration.sql`. The table therefore never existed in
-- managed environments and every request to the agent-gen endpoints failed with
-- a "relation does not exist" error that the production exception filter masked
-- as "Unexpected server error". This migration restores the table in the layout
-- Prisma actually applies. Idempotent and safe to re-run on databases where the
-- table was created by hand or through `prisma db push`.

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_gen_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_user',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "current_spec" JSONB,
    "spec_valid" BOOLEAN NOT NULL DEFAULT false,
    "agent_id" UUID,
    "last_error" TEXT,
    "generating_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_gen_sessions_pkey" PRIMARY KEY ("id")
);

-- Lookup path for "the current session of this user in this workspace".
CREATE INDEX IF NOT EXISTS "agent_gen_sessions_workspace_id_user_id_status_idx"
    ON "agent_gen_sessions"("workspace_id", "user_id", "status");
-- Lookup path for the stale-generation sweep (sessions stuck in 'generating').
CREATE INDEX IF NOT EXISTS "agent_gen_sessions_status_generating_at_idx"
    ON "agent_gen_sessions"("status", "generating_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_gen_sessions_status_check'
      AND conrelid = 'public.agent_gen_sessions'::regclass
  ) THEN
    ALTER TABLE "agent_gen_sessions"
      ADD CONSTRAINT "agent_gen_sessions_status_check"
      CHECK ("status" IN ('awaiting_user', 'generating', 'finalizing', 'completed', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_gen_sessions_workspace_id_fkey'
      AND conrelid = 'public.agent_gen_sessions'::regclass
  ) THEN
    ALTER TABLE "agent_gen_sessions"
      ADD CONSTRAINT "agent_gen_sessions_workspace_id_fkey"
      FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_gen_sessions_organization_id_fkey'
      AND conrelid = 'public.agent_gen_sessions'::regclass
  ) THEN
    ALTER TABLE "agent_gen_sessions"
      ADD CONSTRAINT "agent_gen_sessions_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_gen_sessions_user_id_fkey'
      AND conrelid = 'public.agent_gen_sessions'::regclass
  ) THEN
    ALTER TABLE "agent_gen_sessions"
      ADD CONSTRAINT "agent_gen_sessions_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_gen_sessions_agent_id_fkey'
      AND conrelid = 'public.agent_gen_sessions'::regclass
  ) THEN
    ALTER TABLE "agent_gen_sessions"
      ADD CONSTRAINT "agent_gen_sessions_agent_id_fkey"
      FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Data API exposure posture. agent_gen_sessions is listed in
-- SERVICE_ROLE_ONLY_TABLES (apps/api/src/db/public-table-exposure-policy.ts):
-- the NestJS API owns every read and write, so anon and authenticated get no
-- grants. RLS is enabled with a service_role policy for auditability, plus an
-- owner-scoped policy that keeps the rows locked to the creating user should a
-- future change ever hand `authenticated` a grant. The role guard keeps the
-- migration working on databases without Supabase Data API roles.
-- ---------------------------------------------------------------------------

ALTER TABLE "agent_gen_sessions" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.agent_gen_sessions FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.agent_gen_sessions FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_gen_sessions TO service_role;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'agent_gen_sessions'
        AND policyname = 'agent_gen_sessions_service_role_all'
    ) THEN
      CREATE POLICY "agent_gen_sessions_service_role_all"
        ON public.agent_gen_sessions FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'agent_gen_sessions'
        AND policyname = 'agent_gen_sessions_owner_select'
    ) THEN
      CREATE POLICY "agent_gen_sessions_owner_select"
        ON public.agent_gen_sessions FOR SELECT
        TO authenticated
        USING (EXISTS (
          SELECT 1
          FROM public.users u
          JOIN public.workspace_memberships wm ON wm.user_id = u.id
          WHERE u.id = agent_gen_sessions.user_id
            AND wm.workspace_id = agent_gen_sessions.workspace_id
            AND u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
        ));
    END IF;

    -- Writes additionally require the organization to match the row's
    -- workspace, so a compromised JWT cannot write rows pointing at another
    -- tenant.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'agent_gen_sessions'
        AND policyname = 'agent_gen_sessions_owner_write'
    ) THEN
      CREATE POLICY "agent_gen_sessions_owner_write"
        ON public.agent_gen_sessions FOR ALL
        TO authenticated
        USING (EXISTS (
          SELECT 1
          FROM public.users u
          JOIN public.workspace_memberships wm ON wm.user_id = u.id
          WHERE u.id = agent_gen_sessions.user_id
            AND wm.workspace_id = agent_gen_sessions.workspace_id
            AND u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
        ))
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.users u
            JOIN public.workspace_memberships wm ON wm.user_id = u.id
            WHERE u.id = agent_gen_sessions.user_id
              AND wm.workspace_id = agent_gen_sessions.workspace_id
              AND u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
          )
          AND organization_id = (
            SELECT w.organization_id FROM public.workspaces w
            WHERE w.id = agent_gen_sessions.workspace_id
          )
        );
    END IF;
  END IF;
END $$;
