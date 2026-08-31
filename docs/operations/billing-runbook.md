# VoiceForge AI — Billing Operations Runbook

**Catalog version:** `2026-07-24` (`BILLING_CATALOG_VERSION` in `packages/shared/src/billing/catalog.ts`)
**Applies to:** the production billing implementation (credit ledger, entitlements, reconciliation, Dodo Payments integration)
**Companion document:** `docs/RUNBOOK.md` for host, container, and deploy procedures

The commercial contract lives in one place: `packages/shared/src/billing/catalog.ts`.
Prices, included minutes, quotas, and pack terms are read from it by pricing copy,
checkout, entitlement checks, and margin reporting. Never restate a number from
this document in code — read it from the catalog, and change the catalog when the
commercial terms change.

---

## 1. Dodo Payments Configuration

Everything below is configured in the Dodo Payments dashboard at
<https://app.dodopayments.com>, in the same mode (`test_mode` / `live_mode`) as the
deployment's `DODO_PAYMENTS_ENVIRONMENT`. Product ids are not portable between the
two modes.

### 1.1 Products and recurring prices

Create one Product per paid plan, each priced monthly recurring in USD. Dodo has no
separate price object — the product carries its own price, so there is one id per
plan, not two.

- **Starter** — `$99` / month recurring. Product id goes in `DODO_STARTER_PRODUCT_ID`.
- **Growth** — `$299` / month recurring. Product id goes in `DODO_GROWTH_PRODUCT_ID`.
- **Enterprise** — sales-assisted, from `$999` / month. Product id goes in
  `DODO_ENTERPRISE_PRODUCT_ID`. Enterprise is deliberately excluded from
  self-serve checkout (`isCheckoutPlan` in the catalog returns false for it), so
  this product is only used for contracts created by sales. Its id gates no
  checkout flow (starter/growth checkout works without it), but the webhook
  plan-inferrer recognises a sales-assisted subscription by product id alone and
  the deploy gate requires it on a fully live host — without it such a
  subscription is audited as `billing.subscription_product_unrecognized` and
  stays on its previous plan.

Free has no Dodo product. Free's 10 included minutes are a *recurring monthly*
grant on the in-house standard pipeline only (no PSTN access), provisioned by the
free-credit worker on its schedule — never by a Dodo object.

### 1.2 One-time product for the prepaid minute pack

Create a **one-time** (not recurring) product:

- 100 minutes for `$39`, expiring 365 days after purchase.

The pack terms come from `MINUTE_PACK` in the catalog. The product id is resolved
server-side during top-up checkout. Never accept a product id from a client: a
client-supplied product lets a caller buy minutes at a price of their choosing.

The pack checkout is pinned to card and must stay that way. A
delayed-notification method (ACH, SEPA debit) sits in `payment.processing` for
days before it settles, and credit is granted only on `payment.succeeded` — so the
customer would leave checkout believing they hold minutes they cannot spend yet, and
support would field it as a missing purchase. A subscription is safe with delayed
methods because its credit is granted from `subscription.renewed`, which only fires
once the money has cleared. Enabling extra payment methods on the product in the
Dodo dashboard changes nothing, because the checkout session pins the list. If a
pack payment is ever seen unsettled, it is recorded as
`billing.pack_checkout_unpaid_review` (see §4.2) and must be resolved by hand.

### 1.3 Webhook endpoint

Add a webhook in the Dodo dashboard pointing at
`https://incfrog.ai/api/v1/webhooks/dodo` and store the signing secret in
`DODO_WEBHOOK_SECRET`. Dodo signs per the
[Standard Webhooks](https://www.standardwebhooks.com) spec — `webhook-id`,
`webhook-timestamp` and `webhook-signature` headers, HMAC-SHA256 — and `webhook-id`
is the replay key stored in `dodo_webhook_events.webhook_id`. Subscribe to exactly
these events — this is the set the dispatcher acts on, and
`dodo-webhook.service.test.ts` asserts this list still matches the code:

- `payment.succeeded`
- `payment.failed`
- `refund.succeeded`
- `dispute.won`
- `dispute.lost`
- `subscription.active`
- `subscription.renewed`
- `subscription.plan_changed`
- `subscription.on_hold`
- `subscription.cancelled`
- `subscription.expired`
- `subscription.failed`

This integration consumes no invoice or checkout-session webhooks (Dodo offers
those APIs; the webhook flow here does not use them): a one-time pack is granted
from `payment.succeeded`, and recurring included minutes from
`subscription.renewed`.

`dispute.opened` is deliberately **not** in that list. Credit is reversed only when
a dispute is *lost*, and that is known at `dispute.lost`; subscribing to the opening
event in its place means the reversal handler never runs and disputed minute-pack
credit stays on the account permanently. Over-subscribing is not free either: an
event we do not handle is still recorded in `dodo_webhook_events` and marked
processed, so it reads afterwards as though it had been acted on.

`payment.processing` is deliberately absent for the same reason. It is the event a
delayed-notification pack payment would arrive on, and the pack checkout is pinned
to card (§1.2) precisely so that case cannot arise. Subscribing to it without also
writing a handler would record it as processed and grant nothing, which is worse
than not receiving it.

Entitlement changes are applied **only** from a signature-verified webhook. The
`payment_id` / `subscription_id` params Dodo appends to the return URL are not proof
of payment and must never activate a plan or credit a bucket. Because of this, an
activation can lag the redirect by a few seconds: the return page refetches billing
state once on load, so a customer who lands before the webhook is processed sees
their previous plan or balance until they refresh. Support should treat a short lag
after checkout as expected and confirm against `dodo_webhook_events` rather than the
customer's screen.

Rotating the signing secret: add the new endpoint secret in Dodo, deploy the new
`DODO_WEBHOOK_SECRET`, confirm events are processing, then delete the old
endpoint. Do not remove the old secret before the new one is live, or events are
dropped in the gap and entitlements silently stop updating.

### 1.4 Tax

Nothing to configure. Dodo Payments is the Merchant of Record: it is the seller of
record on the customer's statement and calculates, collects and remits sales tax /
VAT itself, so there is no tax switch, no jurisdiction registration on our side, and
no tax variable in the environment. Tax on a given order is visible on the order in
the Dodo dashboard.

---

## 2. Environment Configuration

All variables below are validated at boot by `apps/api/src/config/env.ts`;
a malformed value fails startup rather than silently defaulting.

### 2.1 Dodo Payments checkout

- `DODO_PAYMENTS_API_KEY` — absent means Dodo operations are unavailable and checkout
  reports temporarily unavailable.
- `DODO_WEBHOOK_SECRET`
- `DODO_STARTER_PRODUCT_ID`, `DODO_GROWTH_PRODUCT_ID`, `DODO_ENTERPRISE_PRODUCT_ID`
- `DODO_MINUTE_PACK_PRODUCT_ID`
- `DODO_PAYMENTS_ENVIRONMENT` — `test_mode` (default) or `live_mode`. Production boot
  fails with an API key set while this is not `live_mode`; a Dodo key carries no mode
  prefix, so this variable is the only place the mode exists.
- There is no demo billing mode. Checkout is enabled only when the API key,
  webhook secret, all three subscription product ids, and the minute-pack product id
  are all configured; partial configuration fails closed.
- `WEB_BASE_URL` — when Dodo checkout is fully configured, this must be an
  absolute non-local HTTPS URL. Boot fails otherwise. Dodo redirects paying
  customers back to this origin, so a default `localhost` value would take payment
  and then bounce the customer to a dead address — a failure no health check can detect.

### 2.2 Reconciliation and cost

- `BILLING_VARIABLE_COST_RESERVE_USD_PER_MINUTE` — default `0.12`. The assumed
  variable cost per connected minute, recorded as a provider cost estimate before
  the provider reports actual usage. Constrained to `(0, 10]` so a misconfigured
  deployment cannot report infinite margin.
- `BILLING_RECONCILIATION_CRON` — default `*/15 * * * *`. 5- or 6-field cron.
- `BILLING_RECONCILIATION_BATCH_SIZE` — default `100`, range `1..1000`. Each run
  is bounded by this, so a backlog drains over several runs instead of one long
  transaction holding locks.
- `BILLING_STALE_CALL_TIMEOUT_MINUTES` — default `30`, range `1..1440`. A call
  that never reported connection is finalized and its reservation released after
  this long, so credit is not held indefinitely.

### 2.3 Workers and Redis

- `WORKERS_ENABLED=true` is required for reconciliation to run at all. In the AWS
  Compose topology this is set only on the dedicated `vf-api-worker` container;
  `vf-api` runs with it false so request-serving replicas never compete for jobs.
  If the worker container is not running, balance drift, expired buckets, and
  leaked concurrency leases accumulate silently until a customer complains.
- Redis must be reachable before the API is considered healthy. Concurrency
  admission is **fail-closed**: when Redis is unavailable, new calls are refused
  rather than admitted without a slot check. Refusing calls is recoverable;
  admitting unlimited concurrent calls is not.
- Redis runs with `maxmemory` 384 MB and `noeviction`. A full Redis fails writes
  loudly instead of silently discarding queued reconciliation jobs.

---

## 3. Capacity and Concurrency

- The platform-wide ceiling is **100 concurrent calls**. This is a hard cap
  independent of what plans have been sold.
- Per-plan concurrency comes from the catalog: Free `0`, Starter `2`, Growth `10`,
  Enterprise `25` with up to `50` by contract
  (`maximumContractConcurrentCalls`).
- Because Enterprise contracts can exceed the standard limit, the sum of sold
  concurrency can exceed 100. Before signing a contract above 25, check current
  peak usage on `voiceforge_calls_active_global` and raise the global ceiling
  deliberately, with capacity to back it.

Runtime internal key (`INTERNAL_API_KEY`) rotation: deploy the new value to both
API and voice runtime in the same release. The runtime authenticates usage events
with `x-internal-key`; a mismatch causes metering requests to fail and the runtime
to terminate calls after the configured consecutive-failure limit. Verify after
rotation that `voiceforge_billing_reserved_seconds` still moves during a live call.

---

## 4. Reconciliation

The credit ledger is the source of truth. `organization_credit_balances` is a
projection of it. Projections drift when a process dies between writes, and a
drifted projection either sells credit twice or refuses credit the customer owns.

`ReconciliationService` (`apps/api/src/billing/reconciliation.service.ts`) runs six
bounded, idempotent repairs, scheduled as separate BullMQ jobs on the
`billing-reconciliation` queue so a failure in one cannot block the others:

- `billing.reconcile.balances` — recompute available seconds from active bucket
  remainder; reserved seconds are tracked separately and are not subtracted twice.
  Correct drift with an audited compensating write.
- `billing.reconcile.buckets` — retire buckets past expiry, zeroing remaining
  seconds and flipping status in one update so the decrement is observed once.
- `billing.reconcile.stale_calls` — finalize calls that never reported connection
  and release their reservation.
- `billing.reconcile.leases` — release concurrency leases whose expiry has passed.
  Leases are only ever *created* by the runtime; reconciliation cannot confirm a
  live call, so it never recreates one.
- `billing.reconcile.costs` — backfill missing provider cost estimates and alert
  on coverage gaps.
- `billing.reconcile.margins` — publish contribution margin per plan.

Per-organization repairs are serialized across API replicas with a transaction-scoped
`pg_try_advisory_xact_lock`. Transaction scope is deliberate: a session-scoped lock
would leak on a pooled connection and permanently block that organization's repairs.

### 4.1 Checking projection health

Every correction writes an audit record. To see what reconciliation has been doing:

```sql
SELECT action, COUNT(*), MAX(created_at)
FROM audit_logs
WHERE action LIKE 'billing.%'
  AND created_at > now() - interval '24 hours'
GROUP BY action
ORDER BY 2 DESC;
```

Relevant actions: `billing.projection_corrected`, `billing.bucket_expired`,
`billing.stale_call_finalized`, `billing.lease_recovered`,
`billing.manual_review_created`, `billing.quota_denied`.

A steady trickle of `billing.projection_corrected` is normal after crashes. A
sustained high rate means writes are failing partway through and needs
investigation, not a larger batch size.

### 4.2 Manual review queue

Ambiguous state is flagged, never guessed. When a stale call already has debits
recorded, reconciliation cannot tell whether the call was billed correctly, so it
sets the balance `status` to `review` with a `review_reason` instead of altering
any customer figure.

```sql
SELECT organization_id, review_reason, available_seconds, reserved_seconds, updated_at
FROM organization_credit_balances
WHERE status = 'review'
ORDER BY updated_at;
```

Resolve by hand: establish what the call actually consumed from
`call_usages` and `billing_ledger_entries`, apply an explicit adjustment entry,
then clear `status` and `review_reason`. Never clear the flag without an
adjustment entry — the flag is the only record that a human looked at it.

The Dodo webhook flags three more conditions it refuses to guess at. None of
them blocks calling; each one is a payer whose commercial state is wrong until
someone acts.

```sql
SELECT action, organization_id, metadata, created_at
FROM audit_logs
WHERE action IN (
  'billing.subscription_product_unrecognized',
  'billing.subscription_link_conflict',
  'billing.pack_checkout_unpaid_review'
)
ORDER BY created_at DESC;
```

- `billing.subscription_product_unrecognized` — a subscription arrived on a product
  id that is not in `DODO_{STARTER,GROWTH,ENTERPRISE}_PRODUCT_ID`. The plan and
  product on the row were left as they were, so a paying customer keeps their
  entitlements; a brand-new subscription stays on Free. Almost always a product
  replaced in Dodo before the environment was redeployed. Fix the environment
  variable, then resend the event from the Dodo dashboard. Do not edit the plan
  column by hand — the redelivered event is the audited path.
- `billing.subscription_link_conflict` — a checkout tried to point an
  organization at a different Dodo customer or subscription than the one
  already stored. The stored link was kept. Usually a customer who reached
  checkout twice, which means **two live Dodo subscriptions and double
  billing**: cancel the surplus one in Dodo, refund it, and only then decide
  which id belongs on the row.
- `billing.pack_checkout_unpaid_review` — a minute-pack payment was seen without a
  settled `payment.succeeded`, so no credit was granted (see §1.2). Confirm in
  Dodo whether the payment ever settled. If it did, grant the pack with an
  explicit adjustment entry referencing the Dodo payment id; if it did not,
  no action is needed beyond closing the record.

### 4.3 Running a repair out of band

Reconciliation is idempotent, so an ad-hoc run is safe. Enqueue the specific job
on the `billing-reconciliation` queue rather than restarting the API; a restart
re-registers schedules but does not force an immediate run.

---

## 5. Provider Costs and Margin

`ProviderCostService` records cost events in three categories: `llm`,
`agent_runtime`, and `sip_trunk`. Costs are recorded per organization and are
**never** written to the customer credit ledger — a provider price change must not
alter what a customer was charged.

When a call connects, an estimate is written using
`BILLING_VARIABLE_COST_RESERVE_USD_PER_MINUTE` against whole minutes rounded up.
The estimate upsert deliberately uses an empty update clause, so a later actual
cost is never overwritten by a subsequent estimate.

`voiceforge_provider_cost_usd_total` is labelled with `estimate="true"` or
`estimate="false"` so an operator can tell settled costs from assumed ones. If
margin looks healthy but nearly all cost is `estimate="true"`, the provider is not
reporting actuals and the margin figure is an assumption, not a measurement.

Margin uses recorded provider cost against the plan's list price from the catalog.
A plan with no active subscriptions is skipped rather than reported as zero, since
zero is indistinguishable from a real collapse in margin.

---

## 6. Metrics and Alerts

Exposed at `GET /api/v1/metrics`, protected by `METRICS_SCRAPE_TOKEN`.

- `voiceforge_billing_available_seconds` — sellable credit not yet reserved.
- `voiceforge_billing_reserved_seconds` — credit held by in-flight calls.
- `voiceforge_calls_active_global` — active concurrency leases platform-wide.
- `voiceforge_calls_admission_denied_total{reason}` — admission denials by reason.
- `voiceforge_provider_cost_usd_total{provider,category,estimate}`
- `voiceforge_plan_contribution_margin_ratio{plan}`
- `voiceforge_billing_reconciliation_corrections_total{type}`

Recommended alerts:

- **Margin** — page when `voiceforge_plan_contribution_margin_ratio` for any paid
  plan drops below `0.50` for 6 hours. Sustained sub-50% contribution means the
  plan is being sold below its cost structure at current usage.
- **Cost coverage** — reconciliation logs an error when more than 1% of calls
  finalized in the last 24 hours have no cost event. Above that threshold, margin
  reporting is running on incomplete data and must not be trusted.
- **Reserved credit** — alert when `voiceforge_billing_reserved_seconds` stays
  high while `voiceforge_calls_active_global` is near zero. That combination means
  reservations are leaking rather than being released.
- **Concurrency** — alert when `voiceforge_calls_active_global` exceeds 90, i.e.
  90% of the global ceiling.
- **Admission denials** — alert on any sustained rate of
  `reason="platform_concurrency_reached"`; that is a capacity problem, not a
  customer problem. `reason="credit_insufficient"` is expected and should not page.
- **Manual review** — alert on any non-zero count of balances in `review` status
  older than 24 hours.

---

## 7. Shadow Metering

Shadow metering records what *would* have been charged without enforcing it, so a
metering change can be validated against real traffic before it can reject a call.

Enable it before any change to rating or admission logic. Compare recorded
`call_usages` against the previous period's invoiced minutes for the same
organizations; investigate any organization whose shadow figure differs from its
enforced figure by more than a rounding minute. Only enforce once the two agree.

---

## 8. Refunds and Disputes

Withdrawing the credit a reversed payment bought is automatic. Deciding what the
customer is owed is not.

- Refunding a subscription invoice does not remove included minutes already
  consumed. Decide explicitly whether to claw back a bucket, and record the
  decision as an adjustment ledger entry with a reference to the Dodo refund.
- Refunding a minute pack should zero the corresponding bucket if the minutes are
  unspent. If they are partly spent, adjust to the unspent remainder rather than
  zeroing, so the customer is not charged for a refunded balance they never used.
- A dispute *opening* runs no code here — we do not subscribe to
  `dispute.opened`, so work from Dodo's own dispute alert. Review
  before restricting service: suspending an organization mid-call is a worse
  outcome than carrying a disputed balance for a few hours.
- `dispute.lost` withdraws the pack credit automatically. `dispute.won` changes
  nothing, by design.
- Every manual adjustment must produce an audit record with the Dodo object id.
  A balance change without a traceable cause is indistinguishable from a bug.

---

## 9. Rollback

The goal of a billing rollback is to stop *new* commitments without corrupting
calls that are already running or balances that are already correct.

**To stop new purchases:**
Remove one required Dodo checkout configuration value (preferably the server-side
`DODO_PAYMENTS_API_KEY`) and redeploy. Checkout and portal actions return a
temporary-unavailable state because partial configuration fails closed. Existing
subscriptions, balances, and running calls are unaffected. This does not grant free
minutes or a trial to anyone.

**To stop new calls without killing active ones:**
Reduce capacity at the admission boundary. Active calls hold their leases and
finish normally; new calls are denied with a stable reason and are visible on
`voiceforge_calls_admission_denied_total`. Never drop the ledger tables or reset
balances to "clear" a problem — the ledger is the only record of what a customer
paid for.

**To stop reconciliation:**
Stop the `vf-api-worker` container (or set `WORKERS_ENABLED=false` on it and
redeploy). The API keeps serving traffic. Do this only for a bounded window while
diagnosing a repair that is making things worse. Drift accumulates the entire time
it is off, so restart the worker as soon as the offending repair is fixed.

**Migration rollback:**
The billing migration adds tables; it does not rewrite existing customer data.
Rolling the application back to a prior release while leaving the tables in place
is safe. Dropping the tables is not, and is never an appropriate rollback step.

---

## 10. Release Verification

Run against a disposable database first, then against production during the
release window. `prisma migrate deploy` is the only supported deployment path
for billing tables. Do not use `prisma db push`: Prisma cannot represent the
billing CHECK constraints in `schema.prisma`, and `db push` can therefore create
tables without the non-negativity guards. `db:verify` asserts those named
constraints exist and fails the release if any are absent.

```powershell
pnpm --filter @voiceforge/api exec prisma migrate deploy
pnpm db:verify
```

Expected: both exit `0`, and the migration reports no null `calls.organization_id`
rows. A null organization id on a call means that call cannot be attributed to a
payer, so the migration refusing to complete is the correct outcome.

### 10.1 The concurrent uniqueness index

`20260814000000_calls_provider_call_uidx_concurrent` builds
`calls_provider_call_uidx` with `CREATE UNIQUE INDEX CONCURRENTLY`, so inbound
and outbound calls keep writing to `calls` while it runs. It contains a single
statement on purpose: Prisma sends a multi-statement migration as one simple
query, which Postgres runs inside an implicit transaction, and a concurrent
build is rejected there with `25001`. Do not add statements to that file.

The duplicate preflight stays in `20260724090000_production_billing`, which runs
first. If duplicate `(provider, provider_call_id)` rows exist, that earlier
migration aborts and the index build is never attempted.

An interrupted concurrent build (deploy timeout, cancelled session, failed
primary) leaves an **invalid** index behind. `IF NOT EXISTS` then treats it as
already present and the retry silently does nothing, so the uniqueness guarantee
the billing code relies on is absent. After any failed or interrupted
`migrate deploy`, check for one:

```sql
SELECT c.relname
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid
  AND c.relname = 'calls_provider_call_uidx';
```

If a row comes back, drop it outside a transaction and re-run `migrate deploy`:

```sql
DROP INDEX CONCURRENTLY IF EXISTS "calls_provider_call_uidx";
```

Until the index is valid, concurrent webhook deliveries can create a second
`calls` row for the same provider call, which double-counts a call's usage.
Treat an invalid index as a release blocker, not a cleanup task.

Then confirm, in order:

1. `GET /api/v1/health` returns healthy and Redis is connected.
2. `GET /api/v1/metrics` exposes the `voiceforge_billing_*` series.
3. The reconciliation schedules registered — the API logs
   `[BillingReconciliation] Repairs scheduled` with the configured cron and batch
   size at startup. If registration failed after retries, the log says the repair
   will not run until the API restarts successfully; treat that as a failed release.
4. Checkout verification, split by environment because production refuses
   `test_mode` at boot: run the full `test_mode` checkout (return page reached,
   plan activates only after the webhook is processed) against a non-production
   deployment *before* the release; on production itself, one **live-mode**
   minute-pack checkout with a real card, then refund it from the Dodo dashboard
   (the ~$1 refund fee is the cost of the smoke test) and confirm the refund
   webhook reverses the credit.
5. `/pricing` states the current catalog prices and included minutes, and makes no
   claim of unlimited usage, rollover, free inbound calls, a Starter free trial,
   HIPAA readiness, an SLA, or multi-region deployment. `apps/web/lib/billing-copy.test.ts`
   enforces this automatically; a failure there is a release blocker, not a
   cosmetic issue.
