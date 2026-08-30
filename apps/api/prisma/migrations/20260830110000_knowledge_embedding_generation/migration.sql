-- Generation marker for embedding rebuilds.
--
-- Resetting a source's embeddings is "null every vector, then let the worker
-- re-embed the null ones". Two resets in quick succession therefore overlap: the
-- worker draining reset N is still holding chunk text it selected before reset
-- N+1 landed, and its UPDATE would store a vector computed from superseded
-- content. Worse, that write makes the chunk non-null again, so the job queued
-- by reset N+1 skips it and the stale vector is permanent.
--
-- The counter is per source, not per chunk: a reset always covers a whole
-- source, and one column beats 1536-dimension bookkeeping on every chunk row.
-- Workers read it before each batch write and stop when it has moved.
--
-- IF NOT EXISTS + DEFAULT 0 NOT NULL: re-runnable, and existing sources start at
-- generation 0 so the first reset after this migration bumps them to 1.

ALTER TABLE "knowledge_sources"
  ADD COLUMN IF NOT EXISTS "embedding_generation" INTEGER NOT NULL DEFAULT 0;
