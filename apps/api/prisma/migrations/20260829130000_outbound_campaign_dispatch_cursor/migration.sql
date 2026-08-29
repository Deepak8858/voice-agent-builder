-- Resume point for outbound campaign dispatch.
--
-- Without it, starting a paused campaign re-enqueued every contact from the top
-- and re-dialled everyone who had already been called. Defaulted rather than
-- nullable so existing rows are valid immediately; 0 is correct for a draft
-- campaign and conservative for a paused one (it resumes from the start, which
-- is the behaviour those rows already had).
ALTER TABLE "outbound_campaigns"
  ADD COLUMN IF NOT EXISTS "dispatched_count" INTEGER NOT NULL DEFAULT 0;
