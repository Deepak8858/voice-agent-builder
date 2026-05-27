## Roadmap Rebaseline and Next Phases

Date: 2026-05-20
Repo: `H:\voice-agent-builder`

### Goal

Reconcile `ROADMAP.md` with the current codebase, verify what is actually built, and define the next execution phases in the right order.

### Verified Current State

#### Built and verified

- Web app production build passes.
  - Verified with `npm run build -w @voiceforge/web`
  - Generated routes include `/pricing`, `/a/[slug]`, `/dashboard/campaigns`, `/dashboard/compliance`, `/dashboard/analytics`, `/dashboard/white-label`, and the agent builder surfaces.
- Production site is reachable.
  - Verified with `Invoke-WebRequest https://vocal.devdeepak.me`
  - Returned HTTP `200`.
- These focused backend areas are green:
  - `src/voice/adapters/vapi.adapter.test.ts`
  - `src/tools/tools.service.test.ts`
  - `src/outbound-campaign/outbound-campaign.service.test.ts`
  - `src/calls/calls.controller.test.ts`
  - `src/agents/publish.test.ts` when `JWT_SECRET` is set to a valid 32+ char value

#### Built in code, but not fully verified end-to-end in this audit

- Raw-body HMAC webhook verification exists in `apps/api/src/calls/voice-webhook.controller.ts`.
- `providerRuntimeId` persistence exists in `apps/api/src/voice/adapters/vapi.adapter.ts`.
- `JWT_SECRET` fail-fast exists in `apps/api/src/config/env.ts` and `apps/api/src/main.ts`.
- Vapi model uses `gpt-4o-mini` in `apps/api/src/voice/adapters/vapi.adapter.ts`.
- Outbound call idempotency exists as a recent-duplicate guard in `apps/api/src/calls/calls.service.ts`.
- Stripe webhook idempotency exists in `apps/api/src/webhooks/stripe-webhook.service.ts`.
- Materialized view SQL exists in `apps/api/prisma/migrations/0034_phase2_materialized_views.sql`.
- Partitioning SQL exists in `apps/api/prisma/migrations/0035_phase2_partitions.sql`.
- Streaming agent generation exists in `apps/api/src/agents/agents.controller.ts` and `apps/web/app/dashboard/agents/new/ai-generate/page.tsx`.
- Visual flow builder exists in `apps/web/components/flow-builder/*` and `apps/web/components/agent-flow-tab.tsx`.
- CSV bulk import + campaign launcher exists in `apps/web/app/dashboard/campaigns/page.tsx`.
- Calendar backend and Google Calendar tool executor exist in `apps/api/src/calendar/*` and `apps/api/src/tools/executors/google-calendar.executor.ts`.
- Referral backend exists in `apps/api/src/referral/*`.
- Weekly digest assembly exists in `apps/api/src/email/email.service.ts`.
- Own voice runtime prototype exists in `apps/voice-edge`.

### Gaps Found During Verification

#### Repo reality differs from `ROADMAP.md`

`ROADMAP.md` is stale in several places:

- It says there is no pricing page. There is.
- It says the visual flow builder claim is fake. A React Flow builder exists.
- It says `providerRuntimeId` persistence is missing. It is implemented.
- It says `gpt-4o` is still hardcoded in Vapi. The adapter now uses `gpt-4o-mini`.
- It treats the free tier as broken/zero-call, but shared limits now define a 5-call / 10-minute trial.

#### Present but incomplete or not wired

- Public share page is incomplete:
  - Frontend route is `/a/[slug]`
  - Backend public endpoint currently resolves `agents/a/:id`
  - `demoAudioUrl` is returned as `null`
- Form-mode editor exists in `apps/web/components/form-mode-editor.tsx` but is not used anywhere.
- Landing page references `/demo/dental-receptionist-30s.mp3`, but `apps/web/public/demo` is empty.
- Weekly digest logic exists, but there is no scheduler/worker wiring to actually send it.
- `apps/voice-edge` exists as a prototype service, but it is not clearly integrated into the main voice provider selection path.

#### Test and contract drift

Focused verification exposed real repo instability:

- `src/compliance/compliance.test.ts` fails in multiple cases.
- `src/analytics/analytics.test.ts` fails heavily.
- `src/billing/billing.service.test.ts` fails because tests still expect free outbound access to be disabled, while shared plan limits now allow 5 trial calls.
- `src/calls/ingest-event.test.ts` fails because the service now requires `CacheService.publish`, but the test fixture still constructs `CallsService` without that dependency.
- Some suites now require explicit `JWT_SECRET` setup after env hardening.

This means several roadmap items are implemented, but the repository is not yet internally consistent enough to trust its own regression suite.

### Rebaselined Status by Roadmap Area

#### Phase 1: Security / reliability

Status: Mostly built, but needs regression cleanup.

- Done:
  - webhook raw-body HMAC
  - `providerRuntimeId` persistence
  - `JWT_SECRET` fail-fast
  - Vapi `gpt-4o-mini`
  - outbound duplicate guard
  - Stripe webhook idempotency
  - free-tier behavior updated to trial usage
- Remaining:
  - align tests with the current contract
  - verify live webhook path end-to-end with signed payload tests

#### Phase 2: Data / infra

Status: Partially built.

- Done:
  - materialized view migration
  - partition migration
  - transcript persistence in `CallsService.ingestEvent`
- Remaining:
  - confirm migrations are applied in the target environments
  - decide whether analytics services should read from MVs or continue live-querying
  - add operational refresh scheduling verification

#### Phase 3: Conversion / acquisition UX

Status: Mixed; more built than roadmap claims, but public funnel is unfinished.

- Done:
  - pricing page
  - streaming generation UX
  - visual flow builder
  - campaigns bulk CSV flow
- Remaining:
  - real demo audio asset
  - public share page contract fix
  - wire form-mode editor into builder

#### Phase 4: Own voice runtime

Status: Prototype exists, not productized.

- `apps/voice-edge` is present and non-trivial.
- No evidence in this audit that it is the default production runtime.
- Needs an explicit product decision: integrate, gate, or defer.

#### Phase 5: Compliance hardening

Status: Substantial implementation exists, but tests are not trustworthy yet.

- Done:
  - compliance service
  - DNC / consent / contacts flows
  - E.164-style normalization utilities
  - multi-language opt-out phrase table
- Remaining:
  - reconcile normalization contract vs tests
  - verify reason counting and analytics rollups
  - tighten recording notice enforcement semantics

#### Phase 6+: Growth and scale

Status: backend-heavy partials exist.

- Done:
  - referral backend
  - calendar backend/tooling
  - digest builder
- Remaining:
  - referral UI
  - calendar connection UX
  - digest scheduling and delivery
  - explicit public API / SDK work

### Next Phases

### Phase A: Stabilize Repo Truth

Priority: Highest
Duration: 2-4 days

Why first:
The roadmap is already behind the codebase. Until tests, env assumptions, and public-surface contracts are aligned, every next feature phase will be slower and less trustworthy.

Scope:

- Update `ROADMAP.md` to match the current implementation baseline.
- Fix failing billing tests to match the 5-call / 10-minute free trial contract.
- Fix `calls/ingest-event` tests to inject/mock `CacheService`.
- Reconcile compliance normalization behavior and tests.
- Reconcile analytics tests with the current aggregation semantics.
- Standardize test env bootstrapping for `JWT_SECRET`.

Exit criteria:

- `ROADMAP.md` no longer claims already-built features are missing.
- These suites pass:
  - `src/billing/billing.service.test.ts`
  - `src/calls/ingest-event.test.ts`
  - `src/compliance/compliance.test.ts`
  - `src/analytics/analytics.test.ts`
  - `src/agents/publish.test.ts`

Verification:

```powershell
$env:JWT_SECRET='test-jwt-secret-that-is-long-enough-123456'
npm test -w @voiceforge/api -- src/billing/billing.service.test.ts src/calls/ingest-event.test.ts src/compliance/compliance.test.ts src/analytics/analytics.test.ts src/agents/publish.test.ts
```

### Phase B: Finish Public Funnel

Priority: High
Duration: 3-5 days

Why second:
The repo already has much of the acquisition surface, but a few gaps still undermine the public product story.

Scope:

- Fix public share page contract:
  - either support slug-backed published agents end-to-end
  - or rename the public route to an ID-based path and update all callers
- Add a real demo audio asset, or remove the landing/share page claim until the asset pipeline exists
- Wire `FormModeEditor` into the builder as a real mode, not dead code
- Verify pricing and public pages in-browser

Exit criteria:

- `/pricing` loads and matches the current billing model
- `/a/[slug]` or its replacement works with a real published agent
- landing page demo player points to a valid asset
- form mode is reachable from the main builder flow

Verification:

```powershell
npm run build -w @voiceforge/web
```

Browser checks:

- `/`
- `/pricing`
- published agent share page
- builder page with visual + form editing modes

### Phase C: Productize Growth Workflows

Priority: Medium
Duration: 4-6 days

Scope:

- Build referral UI on top of the existing referral backend
- Build Google Calendar connection UX on top of the existing calendar backend
- Schedule weekly digest generation and email delivery
- Add server-side validation around campaign CSV ingestion to mirror frontend checks

Exit criteria:

- workspace users can generate and see referral links
- calendar connection status is visible and manageable from the dashboard
- weekly digest runs on a schedule in a non-local environment
- campaign imports are validated server-side, not only in the browser

### Phase D: Compliance / Analytics Hardening

Priority: Medium
Duration: 3-5 days

Scope:

- Make phone normalization rules explicit and consistent across shared utils, compliance checks, and campaigns
- Expand multi-language opt-out test coverage
- Verify recording-notice behavior in outbound flows
- Reconcile analytics counts, rates, and compliance rollups with intended product semantics

Exit criteria:

- compliance and analytics suites are green
- call-block and outcome metrics match expected fixtures
- opt-out auto-detection is covered for each supported language

### Phase E: Voice Runtime Decision

Priority: Decision first, build second
Duration: 1-2 days for decision, 1-2 weeks if executed

Scope:

- Decide whether `apps/voice-edge` is:
  - the next production runtime
  - an experimental branch to keep feature-flagged
  - or dead code to remove

Decision criteria:

- latency target
- transcript quality
- operational complexity
- provider spend
- failure modes vs Vapi fallback

Exit criteria:

- one explicit runtime strategy documented
- provider adapter roadmap updated to match that decision

### Recommended Execution Order

1. Phase A: Stabilize repo truth
2. Phase B: Finish public funnel
3. Phase D: Compliance / analytics hardening
4. Phase C: Productize growth workflows
5. Phase E: Voice runtime decision and implementation

### Short Rationale

The repo is farther along than `ROADMAP.md` says, so the right move is not to start a brand-new next feature. The right move is to rebaseline, clean the failing contracts, then finish the half-wired public and growth surfaces that already exist.
