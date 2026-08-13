-- Production billing persistence: durable credits, metering, trials, provider costs, and leases.
-- The existing usage_records table remains unchanged during shadow metering.

-- Restore audit schema drift before billing begins writing organization-scoped rows.
-- Older installations used user_id/entity_type/entity_id/details and did not
-- carry workspace or organization scope. Add the current columns first, then
-- copy legacy data only when those legacy columns still exist.
ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "workspace_id" UUID,
  ADD COLUMN IF NOT EXISTS "organization_id" UUID,
  ADD COLUMN IF NOT EXISTS "actor_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "resource_type" TEXT,
  ADD COLUMN IF NOT EXISTS "resource_id" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB,
  ADD COLUMN IF NOT EXISTS "ip_address" TEXT,
  ADD COLUMN IF NOT EXISTS "user_agent" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'user_id'
  ) THEN
    EXECUTE 'UPDATE "audit_logs" SET "actor_user_id" = "user_id" WHERE "actor_user_id" IS NULL';
    EXECUTE 'ALTER TABLE "audit_logs" ALTER COLUMN "user_id" DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'entity_type'
  ) THEN
    EXECUTE 'UPDATE "audit_logs" SET "resource_type" = "entity_type" WHERE "resource_type" IS NULL';
    EXECUTE 'ALTER TABLE "audit_logs" ALTER COLUMN "entity_type" DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'entity_id'
  ) THEN
    EXECUTE 'UPDATE "audit_logs" SET "resource_id" = "entity_id" WHERE "resource_id" IS NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'details'
  ) THEN
    EXECUTE 'UPDATE "audit_logs" SET "metadata" = "details" WHERE "metadata" IS NULL';
  END IF;
END $$;

UPDATE "audit_logs" AS a
SET "organization_id" = w."organization_id"
FROM "workspaces" AS w
WHERE a."workspace_id" = w."id"
  AND a."organization_id" IS NULL;

UPDATE "audit_logs"
SET "resource_type" = 'legacy'
WHERE "resource_type" IS NULL;

ALTER TABLE "audit_logs"
  ALTER COLUMN "resource_type" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_workspace_id_fkey'
  ) THEN
    ALTER TABLE "audit_logs"
      ADD CONSTRAINT "audit_logs_workspace_id_fkey"
      FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_user_id_fkey'
  ) THEN
    ALTER TABLE "audit_logs"
      ADD CONSTRAINT "audit_logs_actor_user_id_fkey"
      FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "audit_logs_workspace_id_created_at_idx"
  ON "audit_logs"("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_organization_id_idx"
  ON "audit_logs"("organization_id");
CREATE INDEX IF NOT EXISTS "audit_logs_actor_user_id_idx"
  ON "audit_logs"("actor_user_id");

-- Extend subscriptions with the catalog identity captured by Stripe webhooks.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "stripe_product_id" TEXT,
  ADD COLUMN IF NOT EXISTS "catalog_version" TEXT,
  ADD COLUMN IF NOT EXISTS "concurrent_call_limit_override" INTEGER,
  ADD COLUMN IF NOT EXISTS "webhook_updated_at" TIMESTAMP(3);

UPDATE "subscriptions"
SET "catalog_version" = 'legacy'
WHERE "catalog_version" IS NULL;

ALTER TABLE "subscriptions"
  ALTER COLUMN "catalog_version" SET DEFAULT 'legacy',
  ALTER COLUMN "catalog_version" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_concurrent_call_limit_override_check'
  ) THEN
    ALTER TABLE "subscriptions"
      ADD CONSTRAINT "subscriptions_concurrent_call_limit_override_check"
      CHECK (
        "concurrent_call_limit_override" IS NULL
        OR "concurrent_call_limit_override" BETWEEN 1 AND 50
      );
  END IF;
END $$;

-- A processing lease lets an unprocessed Stripe event be reclaimed after a worker crash.
ALTER TABLE "stripe_events"
  ADD COLUMN IF NOT EXISTS "processing_started_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempt_count" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stripe_events_attempt_count_nonnegative_check'
  ) THEN
    ALTER TABLE "stripe_events"
      ADD CONSTRAINT "stripe_events_attempt_count_nonnegative_check"
      CHECK ("attempt_count" >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "stripe_events_processed_at_processing_started_at_idx"
  ON "stripe_events"("processed_at", "processing_started_at");

-- Make organization tenancy explicit on calls without losing legacy rows.
ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "organization_id" UUID;

UPDATE "calls" AS c
SET "organization_id" = w."organization_id"
FROM "workspaces" AS w
WHERE c."workspace_id" = w."id"
  AND c."organization_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM calls WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'production billing migration cannot continue: calls.organization_id contains null rows';
  END IF;
END $$;

ALTER TABLE "calls"
  ALTER COLUMN "organization_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'calls_organization_id_fkey'
  ) THEN
    ALTER TABLE "calls"
      ADD CONSTRAINT "calls_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'calls_agent_version_id_fkey'
  ) THEN
    ALTER TABLE "calls"
      ADD CONSTRAINT "calls_agent_version_id_fkey"
      FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "calls_organization_id_idx"
  ON "calls"("organization_id");

CREATE TABLE "billing_credit_buckets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "original_seconds" INTEGER NOT NULL,
  "remaining_seconds" INTEGER NOT NULL,
  "valid_from" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "priority" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "billing_credit_buckets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_credit_buckets_seconds_nonnegative_check"
    CHECK ("original_seconds" >= 0 AND "remaining_seconds" >= 0),
  CONSTRAINT "billing_credit_buckets_remaining_lte_original_check"
    CHECK ("remaining_seconds" <= "original_seconds")
);

CREATE TABLE "billing_ledger_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "bucket_id" UUID,
  "workspace_id" UUID,
  "call_id" UUID,
  "entry_type" TEXT NOT NULL,
  "seconds" INTEGER NOT NULL,
  "balance_after_seconds" INTEGER NOT NULL,
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT,
  "reason_code" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_ledger_entries_balance_after_seconds_nonnegative_check"
    CHECK ("balance_after_seconds" >= 0)
);

CREATE TABLE "organization_credit_balances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "available_seconds" INTEGER NOT NULL DEFAULT 0,
  "reserved_seconds" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "review_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "organization_credit_balances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_credit_balances_seconds_nonnegative_check"
    CHECK ("available_seconds" >= 0 AND "reserved_seconds" >= 0),
  CONSTRAINT "organization_credit_balances_version_nonnegative_check"
    CHECK ("version" >= 0)
);

CREATE TABLE "call_usages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_call_id" TEXT,
  "direction" TEXT NOT NULL,
  "dispatched_at" TIMESTAMP(3),
  "connected_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "raw_connected_seconds" INTEGER NOT NULL DEFAULT 0,
  "billable_seconds" INTEGER NOT NULL DEFAULT 0,
  "reserved_seconds" INTEGER NOT NULL DEFAULT 0,
  "debited_seconds" INTEGER NOT NULL DEFAULT 0,
  "disposition" TEXT,
  "finalization_state" TEXT NOT NULL DEFAULT 'pending',
  "finalization_idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "call_usages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "call_usages_seconds_nonnegative_check"
    CHECK (
      "raw_connected_seconds" >= 0
      AND "billable_seconds" >= 0
      AND "reserved_seconds" >= 0
      AND "debited_seconds" >= 0
    )
);

CREATE TABLE "runtime_usage_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "validated_payload" JSONB NOT NULL,
  "decision" JSONB,
  "processed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_usage_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "trial_redemptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "initiating_user_id" UUID NOT NULL,
  "agent_version_id" UUID NOT NULL,
  "call_id" UUID,
  "provider_attempts" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "selected_provider" TEXT,
  "provider_session_id" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  "max_duration_seconds" INTEGER NOT NULL DEFAULT 180,
  "disposition" TEXT NOT NULL DEFAULT 'claimed',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "trial_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trial_redemptions_max_duration_seconds_check"
    CHECK ("max_duration_seconds" BETWEEN 1 AND 180)
);

CREATE TABLE "agent_provider_deployments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "agent_version_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_runtime_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "agent_provider_deployments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_cost_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "workspace_id" UUID,
  "call_id" UUID,
  "provider" TEXT NOT NULL,
  "service_category" TEXT NOT NULL,
  "provider_usage_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "measured_unit" TEXT NOT NULL,
  "quantity" DECIMAL(20,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "amount" DECIMAL(20,6) NOT NULL,
  "is_estimate" BOOLEAN NOT NULL DEFAULT false,
  "estimate_version" INTEGER NOT NULL DEFAULT 1,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "reconciled_at" TIMESTAMP(3),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "provider_cost_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_cost_events_quantity_nonnegative_check"
    CHECK ("quantity" >= 0),
  CONSTRAINT "provider_cost_events_amount_nonnegative_check"
    CHECK ("amount" >= 0),
  CONSTRAINT "provider_cost_events_estimate_version_nonnegative_check"
    CHECK ("estimate_version" >= 0)
);

CREATE TABLE "call_concurrency_leases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "lease_token" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "call_concurrency_leases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_credit_buckets_organization_id_source_type_source_id_key"
  ON "billing_credit_buckets"("organization_id", "source_type", "source_id");
CREATE INDEX "billing_credit_buckets_organization_id_status_expires_at_priority_idx"
  ON "billing_credit_buckets"("organization_id", "status", "expires_at", "priority");

CREATE UNIQUE INDEX "billing_ledger_entries_organization_id_idempotency_key_key"
  ON "billing_ledger_entries"("organization_id", "idempotency_key");
CREATE INDEX "billing_ledger_entries_organization_id_created_at_idx"
  ON "billing_ledger_entries"("organization_id", "created_at");
CREATE INDEX "billing_ledger_entries_bucket_id_idx"
  ON "billing_ledger_entries"("bucket_id");
CREATE INDEX "billing_ledger_entries_workspace_id_created_at_idx"
  ON "billing_ledger_entries"("workspace_id", "created_at");
CREATE INDEX "billing_ledger_entries_call_id_idx"
  ON "billing_ledger_entries"("call_id");

CREATE UNIQUE INDEX "organization_credit_balances_organization_id_key"
  ON "organization_credit_balances"("organization_id");

CREATE UNIQUE INDEX "call_usages_call_id_key"
  ON "call_usages"("call_id");
CREATE UNIQUE INDEX "call_usages_finalization_idempotency_key_key"
  ON "call_usages"("finalization_idempotency_key");
CREATE INDEX "call_usages_organization_id_finalization_state_idx"
  ON "call_usages"("organization_id", "finalization_state");
CREATE INDEX "call_usages_workspace_id_created_at_idx"
  ON "call_usages"("workspace_id", "created_at");
CREATE INDEX "call_usages_provider_provider_call_id_idx"
  ON "call_usages"("provider", "provider_call_id");

CREATE UNIQUE INDEX "runtime_usage_events_organization_id_event_id_key"
  ON "runtime_usage_events"("organization_id", "event_id");
CREATE INDEX "runtime_usage_events_call_id_occurred_at_idx"
  ON "runtime_usage_events"("call_id", "occurred_at");
CREATE INDEX "runtime_usage_events_organization_id_processed_at_idx"
  ON "runtime_usage_events"("organization_id", "processed_at");

CREATE UNIQUE INDEX "trial_redemptions_organization_id_key"
  ON "trial_redemptions"("organization_id");
CREATE UNIQUE INDEX "trial_redemptions_call_id_key"
  ON "trial_redemptions"("call_id");
CREATE INDEX "trial_redemptions_initiating_user_id_idx"
  ON "trial_redemptions"("initiating_user_id");
CREATE INDEX "trial_redemptions_agent_version_id_idx"
  ON "trial_redemptions"("agent_version_id");
CREATE INDEX "trial_redemptions_selected_provider_provider_session_id_idx"
  ON "trial_redemptions"("selected_provider", "provider_session_id");

CREATE UNIQUE INDEX "agent_provider_deployments_agent_version_id_provider_key"
  ON "agent_provider_deployments"("agent_version_id", "provider");
CREATE INDEX "agent_provider_deployments_organization_id_idx"
  ON "agent_provider_deployments"("organization_id");
CREATE INDEX "agent_provider_deployments_workspace_id_idx"
  ON "agent_provider_deployments"("workspace_id");
CREATE INDEX "agent_provider_deployments_provider_provider_runtime_id_idx"
  ON "agent_provider_deployments"("provider", "provider_runtime_id");

CREATE UNIQUE INDEX "provider_cost_events_provider_idempotency_key_key"
  ON "provider_cost_events"("provider", "idempotency_key");
CREATE INDEX "provider_cost_events_organization_id_occurred_at_idx"
  ON "provider_cost_events"("organization_id", "occurred_at");
CREATE INDEX "provider_cost_events_workspace_id_occurred_at_idx"
  ON "provider_cost_events"("workspace_id", "occurred_at");
CREATE INDEX "provider_cost_events_call_id_idx"
  ON "provider_cost_events"("call_id");
CREATE INDEX "provider_cost_events_provider_service_category_occurred_at_idx"
  ON "provider_cost_events"("provider", "service_category", "occurred_at");
CREATE INDEX "provider_cost_events_reconciled_at_idx"
  ON "provider_cost_events"("reconciled_at");

CREATE UNIQUE INDEX "call_concurrency_leases_call_id_key"
  ON "call_concurrency_leases"("call_id");
CREATE UNIQUE INDEX "call_concurrency_leases_lease_token_key"
  ON "call_concurrency_leases"("lease_token");
CREATE INDEX "call_concurrency_leases_organization_id_state_expires_at_idx"
  ON "call_concurrency_leases"("organization_id", "state", "expires_at");
CREATE INDEX "call_concurrency_leases_expires_at_idx"
  ON "call_concurrency_leases"("expires_at");

ALTER TABLE "billing_credit_buckets"
  ADD CONSTRAINT "billing_credit_buckets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing_ledger_entries"
  ADD CONSTRAINT "billing_ledger_entries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_ledger_entries"
  ADD CONSTRAINT "billing_ledger_entries_bucket_id_fkey"
  FOREIGN KEY ("bucket_id") REFERENCES "billing_credit_buckets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "billing_ledger_entries"
  ADD CONSTRAINT "billing_ledger_entries_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "billing_ledger_entries"
  ADD CONSTRAINT "billing_ledger_entries_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "organization_credit_balances"
  ADD CONSTRAINT "organization_credit_balances_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "call_usages"
  ADD CONSTRAINT "call_usages_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_usages"
  ADD CONSTRAINT "call_usages_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_usages"
  ADD CONSTRAINT "call_usages_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "runtime_usage_events"
  ADD CONSTRAINT "runtime_usage_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "runtime_usage_events"
  ADD CONSTRAINT "runtime_usage_events_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trial_redemptions"
  ADD CONSTRAINT "trial_redemptions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trial_redemptions"
  ADD CONSTRAINT "trial_redemptions_initiating_user_id_fkey"
  FOREIGN KEY ("initiating_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trial_redemptions"
  ADD CONSTRAINT "trial_redemptions_agent_version_id_fkey"
  FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trial_redemptions"
  ADD CONSTRAINT "trial_redemptions_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_provider_deployments"
  ADD CONSTRAINT "agent_provider_deployments_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_provider_deployments"
  ADD CONSTRAINT "agent_provider_deployments_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_provider_deployments"
  ADD CONSTRAINT "agent_provider_deployments_agent_version_id_fkey"
  FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "provider_cost_events"
  ADD CONSTRAINT "provider_cost_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_cost_events"
  ADD CONSTRAINT "provider_cost_events_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provider_cost_events"
  ADD CONSTRAINT "provider_cost_events_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "call_concurrency_leases"
  ADD CONSTRAINT "call_concurrency_leases_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_concurrency_leases"
  ADD CONSTRAINT "call_concurrency_leases_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data API exposure posture for the new billing tables.
--
-- Every table created above holds revenue-bearing or tenant-billing state and
-- is owned exclusively by Prisma (the postgres role, which is BYPASSRLS).
-- None of them may be reachable through the Supabase Data API, so they follow
-- the deny-by-default posture asserted by SERVICE_ROLE_ONLY_TABLES in
-- apps/api/src/db/public-table-exposure-policy.ts: RLS enabled, no policy for
-- anon or authenticated, and CRUD granted only to service_role.
--
-- Idempotent and safe to re-run. The role guard keeps the migration working on
-- a disposable PostgreSQL instance that has no Supabase Data API roles.
-- ---------------------------------------------------------------------------

ALTER TABLE "billing_credit_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_credit_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_usages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runtime_usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trial_redemptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_provider_deployments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_cost_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_concurrency_leases" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  billing_table TEXT;
  billing_tables TEXT[] := ARRAY[
    'billing_credit_buckets',
    'billing_ledger_entries',
    'organization_credit_balances',
    'call_usages',
    'runtime_usage_events',
    'trial_redemptions',
    'agent_provider_deployments',
    'provider_cost_events',
    'call_concurrency_leases'
  ];
BEGIN
  FOREACH billing_table IN ARRAY billing_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', billing_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', billing_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role',
        billing_table
      );
    END IF;
  END LOOP;
END $$;
