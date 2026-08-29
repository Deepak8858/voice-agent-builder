-- crm_fanout_log's only tenant link was call_id/agent_id, both ON DELETE SET
-- NULL. Give it its own workspace_id and backfill through those FKs while they
-- still exist. Nullable: rows that already lost both FKs cannot be recovered.
ALTER TABLE "crm_fanout_log" ADD COLUMN IF NOT EXISTS "workspace_id" UUID;

UPDATE "crm_fanout_log" AS l
  SET "workspace_id" = c."workspace_id"
  FROM "calls" AS c
  WHERE l."call_id" = c."id" AND l."workspace_id" IS NULL;

UPDATE "crm_fanout_log" AS l
  SET "workspace_id" = a."workspace_id"
  FROM "agents" AS a
  WHERE l."agent_id" = a."id" AND l."workspace_id" IS NULL;

CREATE INDEX IF NOT EXISTS "crm_fanout_log_workspace_id_idx"
  ON "crm_fanout_log" ("workspace_id");
