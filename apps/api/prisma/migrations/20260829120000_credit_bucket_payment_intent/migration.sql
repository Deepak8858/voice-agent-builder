-- Records which Stripe PaymentIntent funded a one-time (minute-pack) credit
-- bucket. Before this column the only thing standing between a redelivered
-- `checkout.session.completed` and a second free pack was the processed-event
-- table; a replay that slipped past it minted another bucket with no trace of
-- the payment it claimed to be for.
ALTER TABLE "billing_credit_buckets"
  ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" TEXT;

-- Partial rather than plain: every pre-existing bucket is NULL and every
-- subscription/free-allowance bucket always will be. Postgres already ignores
-- NULLs in a unique index, so the predicate does not change behaviour — it is
-- written out so the intent ("at most one bucket per real payment, unfunded
-- buckets unconstrained") survives the next person reading the schema.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_bucket_payment_intent_uidx"
  ON "billing_credit_buckets" ("stripe_payment_intent_id")
  WHERE "stripe_payment_intent_id" IS NOT NULL;
