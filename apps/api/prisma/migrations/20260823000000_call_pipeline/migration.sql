-- Records which runtime served each call: 'realtime' (speech-to-speech model) or
-- 'standard' (in-house streaming STT -> LLM -> TTS pipeline).
--
-- The column is nullable with no default on purpose. Calls that completed before
-- pipeline routing existed ran on a runtime this column cannot name, and
-- back-filling them with either value would attribute their minutes to the wrong
-- cost basis and corrupt margin reconciliation. NULL means "not attributable",
-- which is the truth.
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "pipeline" TEXT;

-- Reject any value outside the contract at the database boundary, so a bad
-- deploy or a manual write cannot introduce a third runtime that reporting and
-- admission do not understand. NULL is still permitted for historical rows.
ALTER TABLE "calls" DROP CONSTRAINT IF EXISTS "calls_pipeline_check";
ALTER TABLE "calls"
  ADD CONSTRAINT "calls_pipeline_check"
  CHECK ("pipeline" IS NULL OR "pipeline" IN ('realtime', 'standard')) NOT VALID;
ALTER TABLE "calls" VALIDATE CONSTRAINT "calls_pipeline_check";
