# 16 — Billing and Usage

## Provider
Use Stripe Billing with hosted Checkout and hosted Customer Portal. Checkout uses Stripe Tax.

## Plans
Free: 1 agent, 10 trial minutes, 5 trial outbound calls.
Starter: $49/month, 3 agents, 300 minutes, 100 outbound calls.
Growth: $149/month, 10 agents, 2,000 minutes, 500 outbound calls, white-label, compliance blocks.
Enterprise: $499/month, unlimited usage limits for v1.

## Billable Units
voice minutes, published agents, seats, client workspaces, storage GB, premium integrations, custom domains later.

## Usage Record
```json
{
  "organization_id": "uuid",
  "workspace_id": "uuid",
  "call_id": "uuid",
  "usage_type": "voice_minutes",
  "quantity": 3.4,
  "unit": "minute",
  "cost_cents": 86
}
```

## Stripe Webhooks
checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed.

## Checkout API
Clients call `POST /workspaces/:workspaceId/billing/checkout` with `{ "plan": "starter" | "growth" | "enterprise", "successPath"?: "/dashboard/billing", "cancelPath"?: "/dashboard/billing" }`.
The server maps plans to `STRIPE_STARTER_PRICE_ID`, `STRIPE_GROWTH_PRICE_ID`, and `STRIPE_ENTERPRISE_PRICE_ID`; clients must never send Stripe price IDs.

Customer Portal calls use `{ "returnPath"?: "/dashboard/billing" }`.
All redirect paths must be relative paths under `WEB_BASE_URL`.

## Billing Safety
Use `stripe_events.stripe_event_id` as the webhook idempotency key, do not double bill calls, reconcile provider duration, record provider cost and customer price separately, allow admin adjustments later.
