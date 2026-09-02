-- Campaign-level compliance. The operator attests consent once for the whole
-- contact list and may set a calling window; both are kept with the campaign so
-- the dispatcher can hand the window to every per-call compliance check and the
-- attestation stays auditable next to the list it covered.
ALTER TABLE "outbound_campaigns" ADD COLUMN "compliance" JSONB;
