# 16 — Billing and Usage

## Provider
Use Stripe Billing with hosted Checkout and hosted Customer Portal. Checkout uses Stripe Tax.

## Plans
`packages/shared/src/billing/catalog.ts` is the only source of these numbers
(`BILLING_CATALOG_VERSION` 2026-08-23).
`apps/api/src/billing/billing-doc-drift.test.ts` fails when this section and the
catalog disagree, so a repricing in code cannot ship without this section moving
with it.

Free: $0/month, 1 agent, 10 minutes/month, 1 concurrent call, 1 workspace, 0 integrations, 50 contacts, 0 phone numbers.
Starter: $99/month, 3 agents, 200 minutes/month, 2 concurrent calls, 1 workspace, 2 integrations, 500 contacts, 2 phone numbers.
Growth: $299/month, 10 agents, 1,000 minutes/month, 10 concurrent calls, 5 workspaces, 10 integrations, 5,000 contacts, 10 phone numbers.
Enterprise: from $999/month, 30 agents, 3,000 minutes/month, 25 concurrent calls, 15 workspaces, 25 integrations, 25,000 contacts, 25 phone numbers.

Minute pack: $39 for 100 extra minutes, expires 365 days after purchase.

- Free minutes are a *recurring monthly* grant, not a lifetime trial, and are
  spendable only on the in-house `standard` pipeline. Browser tests draw from the
  same allowance; there is no separate test grant.
- Starter routes 50/50 realtime/standard. Growth and Enterprise are realtime
  only, and Free is standard only. A plan with a 0% share of a pipeline is never
  routed there, not merely unlikely to be.
- Enterprise's price is a floor ("from $999") and it is sales-assisted: only
  Starter and Growth are self-service (`CheckoutPlanSchema`), there is no
  checkout path to Enterprise, and no code reads `STRIPE_ENTERPRISE_PRICE_ID`.
  Its 25 concurrent calls can be raised per contract to at most 50 through
  `subscriptions.concurrent_call_limit_override`.
- Phone-number caps equal the concurrent-call limit on every *paid* plan: a
  number is an inbound lane, so holding more than the plan can answer buys
  nothing, and a provisioned number is recurring platform spend on VoiceForge's
  own Twilio account. Free is the exception and breaks the equality on purpose —
  1 concurrent call but **0** phone numbers, so a free workspace can place and
  receive browser test calls without VoiceForge provisioning a number for it.
- White-label is Growth and Enterprise.
- Compliance blocking (DNC, quiet hours, consent) is on for every plan including
  Free. It is a safety control, not a commercial feature, so no repricing can
  turn it off.
- Included minutes are credit at priority 10 and purchased packs at priority 20:
  the monthly allowance is always spent first, and it is forfeited rather than
  rolled over at period end.

## Billable Units
Voice minutes are the only unit money is charged for. The other entitlements —
agents, workspaces, integrations (Nango connections), concurrent calls, contacts,
phone numbers — are quotas enforced per organization by `EntitlementService`, not
metered lines on an invoice. Seats, storage and custom domains are neither
metered nor capped today.

## Usage Record
Minutes are recorded in seconds, in three tables, not one (see
[`06_DATABASE_SCHEMA.md`](06_DATABASE_SCHEMA.md)):

- `runtime_usage_events` — the raw metered event from the runtime, replay-keyed on
  `(organization_id, event_id)`.
- `call_usages` — one row per call: raw connected, billable, reserved and debited
  seconds, plus the finalization state.
- `billing_ledger_entries` — the money movement itself, with the balance after
  each entry.

`usage_records` is a separate periodic rollup keyed by `billable_metric`
(`calls | minutes | tools | agents`) over a `period_start`/`period_end`; it holds
no per-call row and no cost.

## Stripe Webhooks
checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed, charge.refunded, charge.dispute.closed.

Subscribe to exactly that set, no more and no less. See
[`operations/billing-runbook.md` §1.3](operations/billing-runbook.md) for why
`charge.dispute.created` is not on it.

## Checkout API
All three write routes live under `POST /workspaces/:workspaceId/billing/`:

- `checkout` — `{ "plan": "starter" | "growth", "idempotencyKey": "<uuid>", "successPath"?: "/checkout/success", "cancelPath"?: "/checkout/cancel" }`. `"enterprise"` is rejected by the DTO.
- `topup-checkout` — the minute pack: `{ "idempotencyKey": "<uuid>", "successPath"?, "cancelPath"? }`. One-time `payment` mode, card only, and only for an organization with paid access. Card-only is deliberate: a delayed-notification method completes Checkout `unpaid` and settles on `checkout.session.async_payment_succeeded`, which is not on the subscribed set above, so the pack would be paid for and never granted.
- `portal` — `{ "returnPath"?: "/dashboard/billing" }`.

Reads on the same prefix: `GET subscription`, `status`, `summary`, `usage`, `invoices`.

The server maps plans to `STRIPE_STARTER_PRICE_ID` and `STRIPE_GROWTH_PRICE_ID`, and
the pack to `STRIPE_MINUTE_PACK_PRICE_ID`; clients must never send a Stripe price ID
or an amount. All redirect paths must be relative paths under `WEB_BASE_URL`.

## Stripe Configuration
Every `STRIPE_*` variable is optional at boot — nothing fails to start on a missing
price. The three entry points fail independently, each on its own list in
`apps/api/src/config/env.ts`, because one unset price ID used to 503 all three:

- portal: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- subscription checkout: those two plus `STRIPE_STARTER_PRICE_ID`, `STRIPE_GROWTH_PRICE_ID`
- minute-pack top-up: those two plus `STRIPE_MINUTE_PACK_PRICE_ID`

A missing variable disables only the entry point that needs it, which returns 503
`BILLING_UNAVAILABLE` and never invents a free allowance. `GET .../billing/status`
reports a flag per entry point so the client gates each button on its own. In
production, boot warns which entry points are disabled and names the variables.

## Billing Disabled Mode
Production runs in this mode today. `BILLING_DISABLED` is a host `.env` flag read
only by the deploy gate in `.github/workflows/deploy-aws-ec2.yml`; it is absent
from the API's config schema, so Zod strips it and no application code branches on
it. The gate admits exactly two production states:

- `BILLING_DISABLED=true` — every Stripe variable must be **empty**. A leftover
  test-mode key would boot the API selling real credit for test cards.
- otherwise — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_STARTER_PRICE_ID`, `STRIPE_GROWTH_PRICE_ID`,
  `STRIPE_MINUTE_PACK_PRICE_ID` and `STRIPE_ENTERPRISE_PRICE_ID` must all be set,
  and the secret key must be live-mode. The gate still demands the enterprise
  price that no code reads; setting it is the cost of passing the gate.

With billing off the API boots normally, no Stripe client is constructed, and
checkout, top-up and the portal all report themselves unavailable. Metering never
touches Stripe, so call admission, credit reservation, usage debits and the
recurring Free grant keep working.

## Billing Safety
Use `stripe_events.stripe_event_id` as the webhook idempotency key, do not double bill calls, reconcile provider duration, record provider cost and customer price separately, allow admin adjustments later.
