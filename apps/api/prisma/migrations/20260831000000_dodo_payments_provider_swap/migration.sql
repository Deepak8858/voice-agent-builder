-- Swap the billing provider from Stripe to Dodo Payments (Merchant of Record).
--
-- Every structural statement is a RENAME, never a DROP/CREATE of a table: the
-- billing tables carry the credit ledger's foreign keys and the only record of
-- what a customer paid for, so recreating them would destroy money history even
-- though nobody is paying today.
--
-- Index renames are `IF EXISTS` because the deployed names came from an early
-- `prisma db push` rather than a migration in this folder, so a name may differ;
-- a missed index rename is cosmetic drift, and Prisma reports it. Column renames
-- are unguarded on purpose — a missing column must fail loudly here rather than
-- leave Prisma querying a name the database does not have.

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscriptions RENAME COLUMN stripe_subscription_id TO dodo_subscription_id;
ALTER TABLE public.subscriptions RENAME COLUMN stripe_customer_id TO dodo_customer_id;
ALTER TABLE public.subscriptions RENAME COLUMN stripe_product_id TO dodo_product_id;
ALTER TABLE public.subscriptions RENAME COLUMN stripe_metadata TO dodo_metadata;

ALTER INDEX IF EXISTS public.subscriptions_stripe_subscription_id_key
  RENAME TO subscriptions_dodo_subscription_id_key;
ALTER INDEX IF EXISTS public.subscriptions_stripe_customer_id_idx
  RENAME TO subscriptions_dodo_customer_id_idx;

-- Dodo has no separate price object: a product carries its own price, so the
-- Stripe-era price id has no counterpart to rename into.
DROP INDEX IF EXISTS public.subscriptions_stripe_price_id_idx;
ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS stripe_price_id;

-- ---------------------------------------------------------------------------
-- billing_credit_buckets
-- ---------------------------------------------------------------------------
ALTER TABLE public.billing_credit_buckets
  RENAME COLUMN stripe_payment_intent_id TO dodo_payment_id;

ALTER INDEX IF EXISTS public.credit_bucket_payment_intent_uidx
  RENAME TO credit_bucket_dodo_payment_id_uidx;

-- ---------------------------------------------------------------------------
-- stripe_events -> dodo_webhook_events
--
-- Dodo signs with Standard Webhooks, whose `webhook-id` request header is the
-- event's only stable identifier, so that is what the dedupe column now holds.
-- Renaming a table in Postgres leaves its indexes, constraints and RLS policies
-- attached under their old names, so each is renamed explicitly.
-- ---------------------------------------------------------------------------
ALTER TABLE public.stripe_events RENAME TO dodo_webhook_events;
ALTER TABLE public.dodo_webhook_events RENAME COLUMN stripe_event_id TO webhook_id;

ALTER INDEX IF EXISTS public.stripe_events_pkey RENAME TO dodo_webhook_events_pkey;
ALTER INDEX IF EXISTS public.stripe_events_stripe_event_id_key
  RENAME TO dodo_webhook_events_webhook_id_key;
ALTER INDEX IF EXISTS public.stripe_events_stripe_event_id_idx
  RENAME TO dodo_webhook_events_webhook_id_idx;
ALTER INDEX IF EXISTS public.stripe_events_type_created_idx
  RENAME TO dodo_webhook_events_type_created_idx;
ALTER INDEX IF EXISTS public.stripe_events_processed_at_processing_started_at_idx
  RENAME TO dodo_webhook_events_processed_at_processing_started_at_idx;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stripe_events_attempt_count_nonnegative_check'
  ) THEN
    ALTER TABLE public.dodo_webhook_events
      RENAME CONSTRAINT stripe_events_attempt_count_nonnegative_check
      TO dodo_webhook_events_attempt_count_nonnegative_check;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Clear stale Stripe identifiers.
--
-- Billing has been disabled in production (BILLING_DISABLED=true) and there are
-- zero paying customers, but a test-mode Stripe E2E left a handful of rows whose
-- identifiers now sit in Dodo-named columns. A `sub_`/`cus_`/`pi_`/`evt_` value
-- there is worse than no value: the reconciliation and webhook paths would ask
-- Dodo about an object that has never existed in Dodo. Postgres ignores NULLs in
-- unique indexes, so blanking several rows cannot collide.
-- ---------------------------------------------------------------------------
UPDATE public.subscriptions
SET dodo_subscription_id = NULL,
    dodo_customer_id = NULL,
    dodo_product_id = NULL,
    dodo_metadata = NULL
WHERE dodo_subscription_id LIKE 'sub_%'
   OR dodo_customer_id LIKE 'cus_%'
   OR dodo_product_id LIKE 'prod_%';

UPDATE public.billing_credit_buckets
SET dodo_payment_id = NULL
WHERE dodo_payment_id LIKE 'pi_%';

DELETE FROM public.dodo_webhook_events
WHERE webhook_id LIKE 'evt_%';
