-- Set the dispatch cursor for campaigns that were already paused mid-dial.
--
-- 20260829130000 added `dispatched_count` with DEFAULT 0. That is correct for a
-- draft campaign and harmless for a completed one, but for a campaign that was
-- paused halfway through its list it means the first resume after this deploy
-- re-enqueues from index 0 and dials everyone who was already called a second
-- time. Real phone numbers, and calls the customer pays for twice.
--
-- The default is not *worse* than the old behaviour -- before the column existed,
-- resuming a paused campaign always replayed the whole list -- so this is closing
-- the pre-existing bug for rows that already exist, not repairing damage the
-- previous migration did.
--
-- The cursor is recoverable exactly, not estimated. `stats.in_progress` and
-- `stats.failed` are the only two counters the dispatcher ever writes
-- (outbound-call.worker.ts): every contact handed to the dialer increments
-- exactly one of them -- `in_progress` on a queued call in both the BYO and
-- platform-number branches, `failed` via handleDispatchFailure -- and nothing
-- decrements either. A retryable admission denial re-throws for BullMQ without
-- incrementing, so a retried contact is still counted once. `stats.completed` is
-- never incremented by any code path, so it is deliberately not summed here;
-- including it would be reading a counter that is always 0.
--
-- Their sum is therefore the number of contacts already dispatched, which is
-- precisely what `dispatchedCount` means: outbound-campaign.service.ts uses it as
-- `Math.min(campaign.dispatchedCount, contacts.length)`, an index into the
-- `contacts` JSON array.
--
-- LEAST(..., jsonb_array_length(contacts)) mirrors that clamp in SQL so a stats
-- counter that has drifted above the list length cannot write a cursor past the
-- end. `jsonb_typeof` guards the length call: `contacts` defaults to '[]' but is
-- a free-form Json column, and jsonb_array_length() errors on a non-array
-- instead of returning NULL, which would abort the whole migration.
--
-- Restricted to `dispatched_count = 0` so this is idempotent and cannot walk a
-- cursor backwards over a campaign that has run since the column was added.
UPDATE "outbound_campaigns"
SET "dispatched_count" = LEAST(
      COALESCE(("stats" ->> 'in_progress')::int, 0)
        + COALESCE(("stats" ->> 'failed')::int, 0),
      CASE WHEN jsonb_typeof("contacts") = 'array'
           THEN jsonb_array_length("contacts")
           ELSE 0
      END
    )
WHERE "status" = 'paused'
  AND "dispatched_count" = 0;
