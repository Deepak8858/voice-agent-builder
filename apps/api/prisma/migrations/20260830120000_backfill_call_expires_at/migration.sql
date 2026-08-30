-- Give every existing call the expiry its workspace's policy already implied.
--
-- `calls.expires_at` is nullable and is only ever written by
-- `RetentionService.setExpiresAt` / `updateWorkspaceRetention`, both of which
-- arrived after the column. `sweepExpiredCalls` matches on `expires_at < now()`,
-- and in SQL a NULL is never less than anything, so every call recorded before
-- those writers existed is invisible to the sweep permanently: the workspace
-- advertises a 365-day retention and those recordings, transcripts and caller
-- numbers are kept forever.
--
-- This materialises the policy each workspace already declares rather than
-- inventing one: `created_at + workspaces.retention_days`, the same arithmetic as
-- `computeExpiresAt` in JS and as the re-stamp UPDATE in `updateWorkspaceRetention`.
-- `retention_days` is copied onto the call as well, for the same reason that
-- re-stamp does it: the column records which period the row was stamped under, so
-- a later change to the workspace setting is distinguishable from the original.
--
-- `created_at` is timestamp(3) without a zone while `expires_at` is timestamptz,
-- so `AT TIME ZONE 'UTC'` makes the bridge explicit instead of leaving it to the
-- session TimeZone -- identical to the re-stamp statement, deliberately: two
-- different bridges would give a call a different expiry depending on which of
-- the two wrote it last.
--
-- `WHERE calls.expires_at IS NULL` makes this idempotent and, more importantly,
-- non-destructive to rows that already have an expiry: a workspace that shortened
-- its retention has already had its calls re-stamped, and recomputing from the
-- current setting would be a no-op there but a silent lengthening for any call
-- that was stamped under a longer period and never re-stamped.
--
-- Blast radius, stated plainly: with the 365-day default nothing younger than a
-- year becomes sweepable. Anything older does, the moment RETENTION_SWEEP_ENABLED
-- is turned on -- one 5000-call batch per day.
UPDATE "calls"
   SET "expires_at" = ("calls"."created_at" AT TIME ZONE 'UTC')
                      + (w."retention_days" * INTERVAL '1 day'),
       "retention_days" = w."retention_days"
  FROM "workspaces" w
 WHERE "calls"."workspace_id" = w."id"
   AND "calls"."expires_at" IS NULL;
