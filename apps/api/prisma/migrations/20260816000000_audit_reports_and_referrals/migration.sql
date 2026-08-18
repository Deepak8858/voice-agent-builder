-- audit_reports and referrals exist in schema.prisma and are required by the
-- deploy release gate (db-verify), but no prior migration created them: dev
-- environments got them through `prisma db push`. Create them here so managed
-- environments converge. Idempotent and safe to re-run on databases where
-- db push already created the tables.

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_reports" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "from_date" TIMESTAMPTZ(6) NOT NULL,
    "to_date" TIMESTAMPTZ(6) NOT NULL,
    "auditor_email" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "audit_reports_token_key" ON "audit_reports"("token");
CREATE INDEX IF NOT EXISTS "audit_reports_token_idx" ON "audit_reports"("token");
CREATE INDEX IF NOT EXISTS "audit_reports_organization_id_idx" ON "audit_reports"("organization_id");
CREATE INDEX IF NOT EXISTS "audit_reports_expires_at_idx" ON "audit_reports"("expires_at");

-- CreateTable
CREATE TABLE IF NOT EXISTS "referrals" (
    "id" UUID NOT NULL,
    "referrer_user_id" UUID NOT NULL,
    "referred_user_id" UUID,
    "referrer_workspace_id" UUID NOT NULL,
    "referred_workspace_id" UUID,
    "referrer_organization_id" UUID NOT NULL,
    "referred_organization_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "bonus_minutes" INTEGER NOT NULL DEFAULT 100,
    "bonus_awarded_at" TIMESTAMP(3),
    "invite_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "referrals_invite_token_key" ON "referrals"("invite_token");
CREATE INDEX IF NOT EXISTS "referrals_referrer_user_id_status_idx" ON "referrals"("referrer_user_id", "status");
CREATE INDEX IF NOT EXISTS "referrals_referred_user_id_idx" ON "referrals"("referred_user_id");
CREATE INDEX IF NOT EXISTS "referrals_invite_token_idx" ON "referrals"("invite_token");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referrer_user_id_fkey'
  ) THEN
    ALTER TABLE "referrals"
      ADD CONSTRAINT "referrals_referrer_user_id_fkey"
      FOREIGN KEY ("referrer_user_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referred_user_id_fkey'
  ) THEN
    ALTER TABLE "referrals"
      ADD CONSTRAINT "referrals_referred_user_id_fkey"
      FOREIGN KEY ("referred_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referrer_workspace_id_fkey'
  ) THEN
    ALTER TABLE "referrals"
      ADD CONSTRAINT "referrals_referrer_workspace_id_fkey"
      FOREIGN KEY ("referrer_workspace_id") REFERENCES "workspaces"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referred_workspace_id_fkey'
  ) THEN
    ALTER TABLE "referrals"
      ADD CONSTRAINT "referrals_referred_workspace_id_fkey"
      FOREIGN KEY ("referred_workspace_id") REFERENCES "workspaces"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Data API exposure posture. Both tables are listed in SERVICE_ROLE_ONLY_TABLES
-- (apps/api/src/db/public-table-exposure-policy.ts): RLS enabled, no policies
-- for anon or authenticated, CRUD granted only to service_role. The role guard
-- keeps the migration working on databases without Supabase Data API roles.
-- ---------------------------------------------------------------------------

ALTER TABLE "audit_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "referrals" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  locked_table TEXT;
  locked_tables TEXT[] := ARRAY['audit_reports', 'referrals'];
BEGIN
  FOREACH locked_table IN ARRAY locked_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', locked_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', locked_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role',
        locked_table
      );
    END IF;
  END LOOP;
END $$;
