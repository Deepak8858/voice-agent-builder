-- Campaign-level compliance. The operator attests consent once for the whole
-- contact list and may set a calling window; both are kept with the campaign so
-- the dispatcher can hand the window to every per-call compliance check and the
-- attestation stays auditable next to the list it covered.
ALTER TABLE "outbound_campaigns" ADD COLUMN "compliance" JSONB;

-- One live attested consent per contact and type. Two attestations racing for
-- the same list (a double-clicked campaign create, a campaign and an ad-hoc dial)
-- both pass the "already covered?" read; the index makes the second insert a
-- no-op instead of a duplicate. Partial: records from other sources are not
-- constrained, and a revoked record must not block a new attestation.
CREATE UNIQUE INDEX "consent_records_attested_live_uidx"
  ON "consent_records" ("contact_id", "consent_type")
  WHERE "source" = 'attested' AND "revoked_at" IS NULL;
