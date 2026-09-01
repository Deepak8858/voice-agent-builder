-- Campaigns dialed with the channel name "outbound_campaign" as their
-- compliance purpose, which is not in ALLOWED_OUTBOUND_PURPOSES — so every
-- campaign dial was blocked by the compliance engine. Campaigns now declare a
-- consent-based purpose; existing rows default to the least-assuming one.
ALTER TABLE "outbound_campaigns" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'requested_follow_up';
