-- Billing records must survive the retention sweep.
--
-- `call_usages` and `runtime_usage_events` are the money rows for a call: the
-- seconds reserved, debited and finalized, and the metered minutes behind them.
-- Both had `call_id` NOT NULL with an ON DELETE CASCADE foreign key to `calls`,
-- so `RetentionService.sweepExpiredCalls`' bulk delete destroyed the only
-- evidence that a customer had been charged at all. Retention exists to purge
-- recordings and transcripts; it must never purge the invoice behind them.
--
-- SET NULL, not RESTRICT: RESTRICT would make the sweep fail instead, which
-- turns a data-protection obligation into a deadlock. The rows keep
-- `organization_id`, `workspace_id`, `provider_call_id` and every second they
-- account for, and lose only the pointer to the deleted call.
--
-- The unique index on `call_usages.call_id` stays: Postgres treats NULLs as
-- distinct in a unique index (NULLS DISTINCT is the default), so many purged
-- rows can hold NULL while every live call still has at most one usage row.
--
-- Every statement is defensive so the migration is re-runnable against a
-- database where an earlier attempt got part way: DROP CONSTRAINT IF EXISTS
-- before re-adding, and DROP NOT NULL is a no-op on an already-nullable column.

ALTER TABLE "call_usages" DROP CONSTRAINT IF EXISTS "call_usages_call_id_fkey";
ALTER TABLE "call_usages" ALTER COLUMN "call_id" DROP NOT NULL;
ALTER TABLE "call_usages"
  ADD CONSTRAINT "call_usages_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "runtime_usage_events" DROP CONSTRAINT IF EXISTS "runtime_usage_events_call_id_fkey";
ALTER TABLE "runtime_usage_events" ALTER COLUMN "call_id" DROP NOT NULL;
ALTER TABLE "runtime_usage_events"
  ADD CONSTRAINT "runtime_usage_events_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
