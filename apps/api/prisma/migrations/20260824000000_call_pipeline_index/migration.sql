-- This file deliberately keeps CREATE INDEX CONCURRENTLY as its only index
-- statement so Prisma executes the migration in autocommit mode. PostgreSQL
-- rejects concurrent index builds inside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "calls_pipeline_created_at_idx" ON "calls" ("pipeline", "created_at");
