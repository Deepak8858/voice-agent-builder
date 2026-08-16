-- Concurrent deliveries of the same runtime usage event must not both bill.
-- `claimed_at` is the processing lease that makes the claim atomic, and
-- `attempt_count` makes a repeatedly reclaimed event visible in operations.
ALTER TABLE "runtime_usage_events"
  ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempt_count" INTEGER NOT NULL DEFAULT 0;

-- Rows written before this migration were processed under the previous
-- read-then-write path; marking them claimed keeps the claim predicate honest.
UPDATE "runtime_usage_events"
SET "claimed_at" = COALESCE("processed_at", "created_at"),
    "attempt_count" = 1
WHERE "claimed_at" IS NULL;
