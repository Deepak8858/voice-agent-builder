# VoiceForge AI Production Billing Design

**Date:** 2026-07-24
**Status:** Approved design, ready for implementation planning
**Scope:** Billing, entitlements, usage credits, call admission, concurrency, and profitability controls

## 1. Objective

Replace the current demo billing behavior with a production billing system that:

- charges customers before VoiceForge incurs material calling costs;
- prevents free or unpaid PSTN usage;
- enforces organization-wide plan, minute, integration, agent, workspace, and concurrency limits;
- supports 100 concurrent calls across the VoiceForge platform at launch;
- records customer usage and provider costs separately;
- remains provider-neutral and multi-tenant;
- supports Stripe subscriptions and prepaid minute packs;
- preserves a single lifetime free browser test without creating an unlimited trial loophole.

This design makes PostgreSQL the source of truth, uses Redis only for short-lived distributed coordination, and treats every critical billing transition as idempotent and auditable.

## 2. Launch Commercial Model

All launch pricing is in USD.

| Plan | Price | Included GPT Realtime minutes | Agents | Workspaces | Nango connections | Concurrent calls |
|---|---:|---:|---:|---:|---:|---:|
| Free | $0 | One lifetime browser test, maximum 3 minutes | 1 | 1 | 0 | 1 browser session |
| Starter | $99/month | 200 | 3 | 1 | 2 | 2 |
| Growth | $299/month | 1,000 | 10 | 5 | 10 | 10 |
| Enterprise | From $999/month | 3,000 | 30 | 15 | 25 | 25 by default, contractually configurable up to 50 |

Additional minutes are sold as a prepaid pack of 100 minutes for $39. VoiceForge does not allow postpaid overages, negative balances, or unlimited calling at launch. Auto-recharge is not included in the launch scope.

Included monthly minutes expire at the end of the paid billing period. Purchased minute packs are consumed after included minutes and expire 12 months after purchase. Purchased credits remain recorded after a subscription cancellation, but PSTN calling requires an active eligible subscription.

Enterprise subscriptions are created through a sales-assisted Stripe flow rather than the public self-service checkout.

## 3. Profitability Guardrails

The launch model uses a conservative variable-cost reserve of **$0.12 per connected minute**. This reserve covers the OpenAI Realtime runtime, LiveKit agent and SIP usage, and a safety margin for pricing or traffic variance. Customer-owned Twilio or VoBiz telephone charges are paid by the customer directly and are not included in this reserve.

Expected contribution before Stripe fees, tax, support, refunds, and fixed infrastructure:

| Offering | Revenue | Reserved variable cost | Contribution | Contribution margin |
|---|---:|---:|---:|---:|
| Starter included usage | $99 | $24 | $75 | 76% |
| Growth included usage | $299 | $120 | $179 | 60% |
| Enterprise included usage | $999 | $360 | $639 | 64% |
| 100-minute pack | $39 | $12 | $27 | 69% |

Production monitoring must alert when:

- estimated variable cost exceeds $0.12 per connected minute over a rolling 24-hour window;
- a plan's trailing 30-day contribution margin falls below 50%;
- provider cost events are missing for more than 1% of completed connected calls;
- a customer usage balance becomes negative;
- recorded provider minutes materially exceed customer-billed connected minutes.

Fixed infrastructure, support, refunds, payment fees, and taxes are reported separately so the platform can calculate net margin without hiding costs inside usage estimates.

## 4. Billing Boundaries

Billing and entitlements are enforced at the organization level, not independently per workspace. Every billing record must include `organizationId`; workspace and call identifiers are additional scoped references where relevant.

The billing boundary covers:

- Stripe subscription lifecycle;
- prepaid minute-pack purchases;
- free browser-test redemption;
- plan entitlements;
- call admission and minute reservations;
- global and organization concurrency;
- customer credit debits;
- provider cost accounting;
- reconciliation, alerts, and audit records.

The following remain separate implementation milestones:

- campaign queue execution and pacing;
- Nango OAuth and provider-specific CRM, Google Calendar, and Notion actions;
- visual builder redesign;
- hybrid Cloudflare and container deployment;
- long-conversation memory and retrieval.

Billing exposes entitlements required by those milestones, including campaign availability, Nango connection count, and call concurrency.

## 5. Runtime Provider Policy

### 5.1 Free browser test

The free tier receives one browser-based voice test per organization for its lifetime:

- Vapi is the primary free-test provider;
- Retell is the fallback only when the Vapi attempt cannot be established;
- the session has a hard maximum duration of 180 seconds;
- the fallback attempt is part of the same redemption and must not create a second free test;
- no free PSTN number, inbound call, outbound call, campaign, or recurring monthly test is provided.

### 5.2 Paid calls

Paid calls use the provider-neutral VoiceForge call interface with this launch route:

`Twilio or VoBiz number → LiveKit SIP → LiveKit Agent → OpenAI GPT Realtime`

Customers connect and fund their own Twilio or VoBiz accounts. VoiceForge funds the OpenAI and LiveKit runtime and therefore requires available VoiceForge minute credits before admitting a paid call.

The provider registry must select an adapter from explicit runtime policy and capability, not from hard-coded plan conditionals. Provider attempts, fallback decisions, and final selection are audited.

## 6. Core Components

### 6.1 Billing Catalog

A shared, versioned billing catalog is the canonical source for:

- display prices and plan labels;
- Stripe price environment-key mappings;
- included minutes;
- plan feature flags;
- agent, workspace, connection, and concurrency limits;
- pack size and price;
- catalog version.

Frontend pricing, API enforcement, webhook plan mapping, and tests consume this same catalog. No duplicated plan limits are allowed.

### 6.2 Subscription Lifecycle

Stripe Checkout creates Starter and Growth subscriptions. The Stripe Customer Portal manages payment methods and cancellations. Webhooks are the authority for durable subscription state.

Allowed call-start states are:

- `active`;
- `trialing` only if a paid plan intentionally uses a Stripe trial in the future.

`past_due`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`, and `canceled` block new paid calls. A subscription set to cancel at period end remains usable until Stripe reports the paid period has ended.

### 6.3 Entitlement Service

The entitlement service resolves an organization's current plan and returns typed decisions for:

- creating an agent;
- creating a workspace;
- connecting an integration;
- starting a browser test;
- starting an inbound or outbound call;
- launching or continuing a campaign;
- enabling white-label features;
- acquiring another concurrent-call slot.

Decisions include an allow/deny result, stable reason code, current usage, limit, catalog version, and correlation ID. Denials are safe to display and are logged.

### 6.4 Credit Ledger

Customer minute credits use an append-only ledger plus a transactionally maintained balance projection.

Ledger entry types:

- `subscription_grant`;
- `topup_purchase`;
- `minute_reservation`;
- `minute_debit`;
- `reservation_release`;
- `credit_expiration`;
- `refund_reversal`;
- `manual_adjustment`.

Each entry includes organization, optional workspace and call, credit bucket, signed quantity, currency-related reference where applicable, actor, reason, idempotency key, and timestamp.

Credits are stored as seconds internally to support precise reservations, warnings, and reconciliation. Customer-visible billing is rounded to each started connected minute. A call that connects for any portion of a minute consumes that minute; unanswered and failed-to-connect attempts consume no customer minutes.

### 6.5 Usage Metering

Usage metering receives signed, idempotent runtime events:

- `call_dispatched`;
- `call_connected`;
- `usage_heartbeat`;
- `call_ended`;
- `call_failed`.

The runtime event identifier is unique within the organization. Duplicate or reordered events cannot double-charge a customer. The service records raw duration, billable duration, customer debit, estimation status, and reconciliation status separately.

### 6.6 Concurrency Coordinator

Redis provides short-lived distributed leases for:

- the global platform limit of 100 active connected or connecting calls;
- the organization plan limit;
- campaign worker reservations.

Acquisition and release must be atomic. Leases include the call ID, organization ID, expiry, heartbeat timestamp, and correlation ID. PostgreSQL call state remains authoritative for recovery and audit.

If Redis is unavailable, the system fails closed for new campaign and outbound starts. Existing calls continue, and PostgreSQL recovery reconstructs leases after Redis returns.

### 6.7 Provider Cost Ledger

Provider cost records are distinct from customer credit records. Each completed call records, where available:

- OpenAI audio input and output usage;
- LiveKit agent session duration;
- LiveKit SIP duration;
- provider-specific request or session identifiers;
- actual cost;
- estimated cost when actual usage is unavailable;
- estimate version and reconciliation status.

Estimated events are replaced or reconciled when provider data arrives. Customer credit decisions never depend on delayed provider invoices.

## 7. Required Data Model

Names may be adapted to existing Prisma conventions, but the following invariants are required.

### 7.1 Subscription

Extend the existing subscription representation with:

- `organizationId` as the billing owner;
- Stripe customer, subscription, product, and price identifiers;
- normalized status;
- plan key and catalog version;
- current period start and end;
- cancel-at-period-end state;
- webhook-updated timestamp;
- uniqueness constraints preventing more than one effective primary subscription per organization.

### 7.2 BillingCreditBucket

Represents one grant or purchased pack:

- organization;
- source type;
- source identifier such as Stripe invoice or Checkout Session;
- original seconds;
- remaining seconds;
- valid-from and expires-at;
- priority ordering;
- status;
- unique idempotency reference.

Monthly included buckets are consumed before purchased buckets. Consumption is transactional and may span multiple buckets.

### 7.3 BillingLedgerEntry

An immutable entry includes:

- organization and optional workspace;
- optional call and bucket;
- entry type;
- signed seconds;
- balance-after projection;
- actor type and actor identifier;
- stable reason code;
- idempotency key unique within the organization;
- structured metadata;
- created timestamp.

Corrections create compensating entries. Existing entries are never edited or deleted.

### 7.4 OrganizationCreditBalance

A locked projection contains:

- organization;
- available seconds;
- reserved seconds;
- updated timestamp;
- version for optimistic concurrency.

The ledger is the audit source; the projection provides fast admission checks. A scheduled reconciliation verifies projection equality with non-expired ledger and bucket state.

### 7.5 CallUsage

One record per call includes:

- organization and workspace;
- call and campaign identifiers;
- provider and provider call identifier;
- direction;
- dispatch, connect, and end timestamps;
- raw connected seconds;
- billable seconds;
- reserved and debited seconds;
- disposition;
- finalization state;
- unique finalization idempotency key.

### 7.6 TrialRedemption

One immutable redemption per organization includes:

- organization;
- initiating user;
- agent version;
- provider attempt sequence;
- selected provider;
- session identifiers;
- started and ended timestamps;
- maximum duration;
- final disposition.

The unique organization constraint prevents workspace recreation from resetting the trial.

### 7.7 ProviderCostEvent

Includes:

- organization, workspace, and call;
- provider;
- service category;
- provider usage identifier;
- measured unit and quantity;
- currency and amount;
- actual or estimated classification;
- estimate version;
- occurred and reconciled timestamps;
- unique provider event or internal idempotency key.

## 8. Stripe Flows

### 8.1 Subscription Checkout

The API creates Stripe Checkout Sessions in `subscription` mode using server-side price mappings. It includes organization metadata and a generated integration identifier. The return URL cannot be treated as payment confirmation.

Subscription credits are granted only from an idempotently processed successful Stripe invoice event. The Stripe invoice ID is the grant idempotency source. Webhook signature verification occurs before parsing or mutation.

### 8.2 Minute-Pack Checkout

The API creates a one-time Stripe Checkout Session for the fixed 100-minute pack. The pack price comes from an environment-configured Stripe Price ID mapped by the shared catalog.

Credits are granted only after a verified successful payment event. Checkout Session and Payment Intent identifiers are recorded. A retry or duplicate webhook cannot grant a second pack.

If Stripe later confirms a refund, dispute loss, or payment reversal, unused seconds from the related bucket are removed first. If the purchased credit has already been consumed, the organization is blocked from new calls and flagged for manual review; the ledger must not silently become negative.

### 8.3 Tax

Stripe Tax is disabled by default. It may be enabled only through explicit production configuration after the business has confirmed required tax registrations in the relevant jurisdictions. Enabling automatic tax without registrations is prohibited.

### 8.4 Portal and Dunning

The Customer Portal can manage payment methods and cancellation. Webhook status changes update entitlements. A `past_due` transition blocks new calls and campaigns but does not forcibly terminate a call already connected; that call is allowed through its current reserved minute and then follows the normal balance warning and termination flow.

### 8.5 Stripe Security

- Secret keys remain server-side and are never logged.
- Webhook signatures use the raw request body.
- Webhook events are stored and processed idempotently.
- Metadata is validated against the authenticated organization's server-side checkout request.
- Client-provided plan keys, prices, credits, and organization IDs are never trusted.
- API and SDK versions are pinned and upgraded deliberately with tests.

## 9. Call Admission and Charging Algorithm

### 9.1 Paid outbound or inbound call

Before dispatch:

1. Resolve and validate the organization, workspace, agent version, and connected phone provider.
2. Run all required compliance checks. Billing can never bypass compliance.
3. Confirm an active eligible subscription and a minimum of 60 available credit seconds.
4. Atomically acquire the organization concurrency lease and one of the 100 global platform leases.
5. Transactionally reserve 60 seconds from eligible credit buckets.
6. Persist the admission decision and audit record before provider dispatch.
7. Dispatch through the selected provider adapter with an idempotency key.

If the call does not connect, release the full reservation. Telephone-provider charges paid directly by the customer remain outside VoiceForge billing.

On connection:

1. Convert the first reserved minute to a debit.
2. Before each next minute boundary, reserve the next 60 seconds.
3. Receive signed usage heartbeats and update the call record idempotently.
4. When fewer than 60 unreserved seconds remain, do not reserve another minute.
5. At the end of the final paid minute, play a concise 30-second low-balance warning only when runtime timing permits without exceeding paid usage, then close the conversation gracefully.
6. Finalize duration, debit, provider cost, disposition, and audit data.
7. Release organization and global leases even if finalization requires later retry.

The implementation may issue the warning during the final reserved minute. It must never provide an additional unpaid minute.

### 9.2 Campaign admission

Campaign jobs are queued, never rejected merely because the global platform is busy. Workers acquire all compliance, plan, organization, global, and minute reservations immediately before dispatch. Jobs that cannot acquire capacity return to the queue with bounded jitter and fair organization scheduling.

A campaign cannot reserve the full platform indefinitely. Lease duration and per-organization dispatch pacing protect interactive calls and other organizations from starvation.

### 9.3 Recovery

Runtime heartbeats renew leases. Expired leases trigger a PostgreSQL-backed recovery check:

- an active provider call recreates the lease and continues metering;
- a terminated or missing provider call is finalized and releases any remaining reservation;
- an ambiguous provider state blocks duplicate redispatch and enters reconciliation.

Every provider dispatch and call finalization has a durable idempotency key.

## 10. Free Browser-Test Algorithm

1. Confirm the organization has no `TrialRedemption`.
2. Validate the agent version and browser-session request.
3. Create the immutable redemption before contacting a provider.
4. Attempt Vapi.
5. If Vapi cannot establish the session, record the failure and attempt Retell under the same redemption.
6. Enforce a provider-side and VoiceForge-side 180-second maximum.
7. End the session at the limit and finalize the redemption.

A browser refresh, different workspace, additional organization member, failed UI callback, or provider fallback does not issue another free test. Administrators may add a manually audited trial exception through a compensating record; ordinary users cannot reset it.

## 11. API Surface

The implementation exposes authenticated, organization-scoped endpoints for:

- current catalog and effective plan;
- current subscription state;
- Checkout Session creation for subscription;
- Checkout Session creation for minute pack;
- Customer Portal Session creation;
- credit balance and bucket summary;
- usage history and call-level billing detail;
- entitlement checks used by the UI;
- Stripe webhook ingestion;
- signed internal runtime usage events;
- internal lease and reconciliation operations.

All mutation endpoints require validation, authorization, idempotency where applicable, rate limits, and audit logging. Internal runtime endpoints use short-lived service authentication plus signed event payloads.

## 12. Product Experience

The billing UI must make costs and constraints explicit:

- show included, purchased, reserved, and expiring minutes separately;
- display the connected-minute rounding rule before purchase;
- show the customer's current plan and renewal date;
- show plan limits for agents, workspaces, integrations, and concurrency;
- block PSTN setup on Free with a clear upgrade path;
- show that Twilio or VoBiz charges are paid separately by the customer;
- warn before included or purchased credits expire;
- expose a one-click prepaid pack purchase;
- show stable, actionable reasons for blocked calls or campaigns;
- never claim a payment or credit succeeded solely from a Checkout return page.

## 13. Multi-Tenancy, Permissions, and Audit

Every query and mutation is scoped by organization and, where appropriate, workspace. Billing administration is restricted to authorized organization roles. Provider credentials are encrypted and never returned to the browser after storage.

Audit logs are required for:

- subscription and plan changes;
- checkout and portal creation;
- credit grants, reservations, debits, releases, reversals, and adjustments;
- trial redemption and provider fallback;
- call admission allow and deny decisions;
- concurrency lease recovery;
- reconciliation changes;
- administrator overrides;
- provider cost estimation and correction.

Audit metadata excludes secrets, raw payment data, and unnecessary personal information.

## 14. Reliability and Reconciliation

Scheduled jobs must:

- reconcile Stripe subscription state against local state;
- reconcile credit balance projections against ledger and buckets;
- expire included and purchased credit buckets;
- find admitted calls without runtime completion;
- find runtime calls without a durable admission record;
- reconcile estimated provider costs with actual provider records;
- detect stale Redis leases;
- calculate plan contribution margins and alert on guardrail violations.

Reconciliation jobs are idempotent and produce audit records for every correction. They use bounded batches and organization-scoped locks.

## 15. Rollout

1. Introduce the versioned catalog and organization billing ownership without changing existing production behavior.
2. Add ledger, buckets, balance projection, trial redemption, call usage, and provider cost records.
3. Backfill current subscriptions and record a migration audit report.
4. Implement Stripe subscription and pack flows in test mode.
5. Add organization entitlement checks to agent, workspace, integration, and call boundaries.
6. Add minute reservations and global/organization concurrency behind feature flags.
7. Shadow-meter calls without blocking and compare results with existing usage.
8. Enable enforcement for internal organizations, then selected test organizations.
9. Enable production checkout and enforcement after reconciliation is clean.
10. Remove demo billing mode and obsolete duplicated limits after rollback confidence is established.

No migration may silently grant recurring free PSTN minutes. Any temporary migration credit is a named, expiring, audited bucket.

## 16. Testing Requirements

### Unit tests

- catalog values and price mappings;
- plan and organization entitlement decisions;
- bucket ordering and expiration;
- reservation, debit, release, reversal, and reconciliation arithmetic;
- partial-minute rounding;
- subscription-status admission rules;
- free-test lifetime uniqueness and provider fallback;
- Stripe event idempotency;
- provider-cost estimation.

### Integration tests

- verified and invalid Stripe webhook signatures;
- duplicate and reordered invoice, payment, refund, and subscription events;
- concurrent reservations against the same organization balance;
- concurrent acquisition of the 100th and 101st platform slots;
- Redis failure and lease reconstruction;
- provider dispatch timeout, no-answer release, connection, heartbeat, and finalization;
- workspace isolation within an organization and organization isolation across tenants;
- purchased pack grant and refund reversal.

### End-to-end tests

- Free user completes exactly one browser test and cannot initiate PSTN calls;
- Starter subscribes, receives 200 minutes, connects Twilio or VoBiz, and makes a paid call;
- a connected partial minute consumes one minute and a no-answer consumes zero;
- a customer buys a 100-minute pack and balance updates only after webhook confirmation;
- calls queue when platform concurrency reaches 100;
- an organization cannot exceed its plan concurrency while other organizations retain capacity;
- insufficient balance prevents dispatch;
- a running call receives the low-balance flow and terminates without unpaid usage;
- past-due subscriptions cannot start calls or campaigns;
- billing dashboards match ledger, calls, and Stripe events.

## 17. Acceptance Criteria

The billing milestone is complete only when:

- no paid call can dispatch without compliance, subscription, capacity, and minute checks;
- no free account can obtain PSTN usage;
- the lifetime free test cannot be reset through workspace or member changes;
- duplicate runtime or Stripe events cannot duplicate charges or grants;
- the platform never exceeds 100 admitted active calls;
- organization concurrency limits are enforced across all workspaces;
- unanswered calls release VoiceForge minute reservations;
- customer credits and provider costs are separately queryable and reconcilable;
- plan limits come from one shared catalog;
- all billing mutations are organization-scoped, validated, permissioned, idempotent, and audited;
- test suites cover the failure and concurrency paths, not only successful checkout.

## 18. Recorded Next-Runtime Requirement: Long-Conversation Memory

Long conversations must remember early questions without repeatedly sending the full transcript or caching generated answers as truth.

The later runtime design will use:

- the recent verbatim transcript window for conversational continuity;
- structured call facts with provenance for names, preferences, objections, booking details, and commitments;
- a rolling summary that preserves unresolved questions and earlier user requests;
- retrieval of relevant older transcript turns when the caller refers back to them;
- Redis for low-latency active-call state and PostgreSQL for durable recovery;
- prompt-compaction thresholds and model-input metrics;
- explicit invalidation or correction when a caller changes a fact;
- no cross-organization or cross-caller memory leakage.

Frequently reused stable tool results may use short, scoped caches. Generated conversational answers are not blindly cached because stale or contextually incorrect answers reduce accuracy. This memory architecture is expected to improve response speed and recall while keeping token and audio-runtime costs controlled.
