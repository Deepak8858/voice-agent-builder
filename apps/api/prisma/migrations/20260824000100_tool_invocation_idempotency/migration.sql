ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "tool_invocations_idempotency_uidx"
  ON "tool_invocations" ("workspace_id", "tool_id", "idempotency_key");
