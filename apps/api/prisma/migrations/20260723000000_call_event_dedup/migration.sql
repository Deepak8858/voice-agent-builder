ALTER TABLE "call_events"
ADD COLUMN IF NOT EXISTS "provider_event_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "call_events_provider_event_id_key"
ON "call_events" ("provider_event_id");
