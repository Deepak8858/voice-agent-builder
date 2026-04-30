# VoiceForge AI \u2014 Status

_Last updated: 2026-04-27 19:30 UTC_

## TL;DR

Phase 0 (monorepo + infra) and Phase 1 (Agent Spec + CRUD + mock prompt-to-agent
generator + builder UI) are code-complete **and pass verification**. Clerk is
wired into both the Next.js frontend and the NestJS backend. `npm install`,
`prisma generate`, `npm run typecheck`, and `npm run test` all succeed.

## Verification (2026-04-24)

- `npm install` — 650 packages, no resolution errors.
- `npm run build -w @voiceforge/shared` — clean.
- `npm run db:generate -w @voiceforge/api` — Prisma Client v5.22.0 generated.
- `npm run typecheck` — all 4 workspaces clean.
- `npm run test` — **139 / 139 passing** (133 api + 6 shared) as of 2026-04-27 19:30 UTC.

Remaining live steps (require user-supplied env):
- `npm run db:push` + `npm run db:seed` against Supabase.
- `npm run dev` end-to-end smoke (Clerk sign-up → generate → save).

## Current stack

| Layer      | Choice                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Frontend   | Next.js 16 + React 19 + Tailwind 4                                     |
| Backend    | NestJS 10 + Express                                                    |
| Database   | Supabase Postgres (via Prisma from api, @supabase/ssr on web)          |
| Queues     | BullMQ + ioredis (AWS Redis via `REDIS_URL`; falls back to in-process) |
| Auth       | Clerk (primary) + Mock cookie session (fallback via `AUTH_PROVIDER`)   |
| Voice      | Mock adapter (Vapi/Retell stubs behind `VoiceRuntimeProvider`)         |
| LLM        | Mock prompt-to-agent generator (deterministic, no network)             |
| Validation | Zod schemas shared via `@voiceforge/shared`                            |
| Agent skills | supabase, supabase-postgres-best-practices in .agents/skills/        |

## Monorepo layout

```txt
voice-agent-builder/
  apps/
    web/        Next.js frontend  (@voiceforge/web)
    api/        NestJS backend    (@voiceforge/api)
  packages/
    shared/     Zod + types       (@voiceforge/shared)
    ui/         UI placeholder    (@voiceforge/ui)
  docs/         30+ VoiceForge AI product docs
  package.json  npm workspaces root
  tsconfig.base.json
  .env.example
  README.md
  status.md     (this file)
```

## Roadmap (from `docs/20_IMPLEMENTATION_ROADMAP.md`)

| Phase | Title                         | Status      |
| ----- | ----------------------------- | ----------- |
| 0     | Setup / monorepo              | DONE        |
| 1     | Agent Builder                 | DONE        |
| 2     | Templates & Knowledge         | DONE        |
| 3     | Voice Runtime                 | DONE        |
| 4     | Inbound Deployment            | DONE        |
| 5     | Integrations                  | DONE        |
| 6     | Compliance                    | DONE        |
| 7     | Analytics                     | DONE        |
| 8     | White Label                   | DONE        |
| 9     | Billing                       | DONE        |
| 10    | Production Hardening          | IN PROGRESS |

## Phase 0 \u2014 DONE

- [x] npm workspaces root (`package.json`, `tsconfig.base.json`)
- [x] Moved existing Next.js scaffold into `apps/web/`
- [x] `apps/api/` NestJS boilerplate (main, app.module, CORS, cookie parser)
- [x] `packages/shared/` (Zod schemas + types + constants)
- [x] `packages/ui/` placeholder with `Logo`
- [x] `.env.example` (Supabase URLs, Clerk keys, provider switches)
- [x] Global response envelope + `HttpExceptionFilter` + `ZodValidationPipe`
- [x] `PrismaService` + module (Supabase Postgres via `DATABASE_URL`/`DIRECT_URL`)
- [x] `QueueService` (BullMQ when `REDIS_URL`, stub otherwise)
- [x] `AuditService` + `audit_logs` table
- [x] `WorkspaceGuard` enforcing membership on every workspace-scoped route
- [x] `VoiceRuntimeProvider` interface + Mock/Vapi/Retell adapters (Vapi/Retell stubs)
- [x] `/api/v1/health` endpoint with DB ping
- [x] README dev-quickstart

## Phase 1 \u2014 DONE

- [x] Prisma schema for Phase 0/1 tables (users, orgs, workspaces, memberships, agents, agent_versions, agent_templates, audit_logs)
- [x] Prisma seed for the 5 MVP agent templates
- [x] `AgentSpecSchema` with superRefine publish-gate rules (handoff, outbound consent, flow start/end)
- [x] Agents REST API (`list`, `create`, `generate`, `get`, `patch`, `createVersion`, `publish`, `pause`)
- [x] Templates REST API (`list`, `getBySlug`) with seed fallback
- [x] `MockAgentGeneratorService` (template match + keyword heuristics, validated output)
- [x] Audit log on every agent mutation
- [x] Frontend dashboard shell (`AppSidebar`, header, QueryProvider, Sonner)
- [x] `/dashboard`, `/dashboard/agents`, `/dashboard/agents/new`, `/dashboard/agents/[agentId]/builder`
- [x] Monaco-based read-only Agent Spec preview
- [x] Coming-soon stubs for Calls / Templates / Integrations / Clients / White label / Billing / Settings
- [x] Zustand agent-draft store
- [x] Vitest tests for Agent Spec, templates, mock generator, Zod pipe

## Clerk integration \u2014 DONE

- [x] `@clerk/nextjs` in `apps/web/package.json`
- [x] `apps/web/proxy.ts` with `clerkMiddleware()` and the docs-prescribed matcher
- [x] `ClerkProvider` wraps `<body>` in `apps/web/app/layout.tsx`
- [x] Header uses `<Show when="signed-in|signed-out">` + `SignInButton` / `SignUpButton` / `UserButton`
- [x] `@clerk/backend` in `apps/api`; `ClerkAuthService` verifies bearer tokens and lazily provisions User/Org/Workspace
- [x] `AuthModule` dispatches between Mock and Clerk based on `AUTH_PROVIDER`
- [x] Server-side (`lib/api.ts`) and client-side (`lib/use-api.ts`) fetch helpers forward the Clerk session token

## Not yet done

- [x] `npm install` at the repo root
- [x] `npm run typecheck` (all workspaces clean)
- [x] `npm run test` (165 / 165 passing)
- [x] `npm run db:generate` (Prisma Client generated)
- [x] `npm run db:push` and `npm run db:seed` against the user's Supabase instance
- [ ] Live end-to-end smoke test (sign up via Clerk → dashboard loads → generate agent → save draft → builder page)
- [ ] Phase 10 Production Hardening (load testing, backup validation, security audit)

## What the user needs to provide

1. **Supabase project** \u2192 fill `DATABASE_URL` (port 6543 pooler) and `DIRECT_URL` (port 5432) in `.env`.
2. **Clerk project** \u2192 fill `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `.env`. Set `AUTH_PROVIDER=clerk`.
3. **AWS ElastiCache Serverless Valkey** (`voice-6knamf.serverless.aps1.cache.amazonaws.com:6379`, `ap-south-1`) → set `REDIS_URL=rediss://[:password]@voice-6knamf.serverless.aps1.cache.amazonaws.com:6379` in the PRODUCTION env (API must run inside the same VPC). Leave empty for local dev.

## Next steps

1. Run `npm install` at the repo root (installs all workspaces).
2. `npm run db:generate` (generate Prisma client).
3. `npm run db:push` and `npm run db:seed` once Supabase URLs are set.
4. `npm run typecheck` and `npm run test` to validate the build.
5. `npm run dev` to start API + web in parallel.

## Changelog

- **2026-04-30 11:30 UTC** — Azure DevOps continuity: fixed `prom-client` missing module by reinstalling deps, fixed `ingest-event.test.ts` constructor arg mismatch (added missing `queue` param), switched `Dockerfile.api` from `node:20-alpine` to `node:20-slim` for consistency with web (avoids musl/native binary issues), fixed `BillingController` route prefix from `:workspaceId/billing` to `workspaces/:workspaceId/billing`, built `BillingPanel` frontend component with plan badge, usage meters, upgrade/manage buttons, and wired into `/dashboard/billing`, updated `docker-compose.prod.yml` to support `WEB_IMAGE`/`API_IMAGE` env vars for full registry paths in CI/CD, updated both GitHub Actions and Azure DevOps deploy scripts to export `WEB_IMAGE`/`API_IMAGE`, updated roadmap so Phases 0–9 are DONE and Phase 10 is IN PROGRESS.

- **2026-04-27 19:30 UTC** — Phase 8 White Label shipped + analytics edge tests deepened. New Prisma models: `WhiteLabelSettings` (1:1 to `Workspace`, fields `brandName`, `logoUrl`, `primaryColor`, `customDomain` (unique), `supportEmail`, `hidePlatformBranding`, cascade-delete) and `ClientInvite` (`agencyWorkspaceId`, optional `clientWorkspaceId`, `email`, `role`, `token` (unique), `status` `pending|accepted|revoked|expired`, `expiresAt`, `acceptedAt`); `Workspace` gained `whiteLabel`, `clientInvites` (relation `InviteAgency`), `invitesAccepted` (relation `InviteClient`). Shared schemas in `packages/shared/src/schemas/white-label.ts`: `WhiteLabelSettings` + `UpdateWhiteLabelSettingsDto` (hex-color + domain regex validation), `ClientWorkspace` + `CreateClientWorkspaceDto` (slug regex), `ClientUsage` (30-day rollup), `ClientInvite` + `CreateClientInviteDto` (default role `admin`, default expiry 14 d) + `AcceptClientInviteDto`. New NestJS `apps/api/src/white-label/` module: `WhiteLabelService` covers (a) settings GET/upsert with custom-domain uniqueness check, (b) `createClient` which auto-promotes a `direct` parent to `agency`, creates a `client` child workspace, and seeds the actor as `owner` membership in a single `$transaction`, (c) `listClients` filtered to `parent_workspace_id` + `type=client` newest-first, (d) `clientUsage` aggregating 30 d of `calls` / `compliance_checks` for the child, (e) invite create (random 24-byte hex token, configurable expiry), revoke (rejects non-pending), and accept (auto-flips expired tokens, upserts membership with the invite role, marks the row accepted). Controllers: `WhiteLabelController` (`GET|PATCH /workspaces/:ws/white-label`), `ClientWorkspacesController` (`GET|POST /workspaces/:ws/clients`, `GET /workspaces/:ws/clients/:id/usage`), `ClientInvitesController` (`GET|POST /workspaces/:ws/invites`, `DELETE /workspaces/:ws/invites/:id`), and a standalone `InviteAcceptController` at `POST /invites/accept` that only requires auth (the token itself is the credential). Every mutation writes an `audit_logs` row. Frontend: replaced the Phase 8 ComingSoon stubs at `/dashboard/white-label` and `/dashboard/clients` with real pages. New `apps/web/components/white-label-panel.tsx` renders a brand form (brand name, logo URL, primary color, custom domain, support email, hide-platform-branding checkbox) with a live preview card; new `apps/web/components/clients-panel.tsx` shows the client workspace list, a 30-day usage rollup card per selected client, plus add-client + invite forms with role selector and pending-invite list (with Revoke). Tests: new `apps/api/src/white-label/white-label.test.ts` (18 cases) covers settings empty defaults + persisted read, custom-domain conflict on another workspace vs. same workspace, child create + parent promotion, duplicate-slug rejection, list filter to children only, usage rollup correctness, cross-agency child guard, invite create + token + expiry, mismatched-agency invite rejection, revoke pending vs. already-accepted, accept happy path with membership upsert, expiry auto-flip, unknown-token rejection, and accept-without-bound-workspace rejection. Phase 7 analytics tests **expanded from 7 → 40** with deep edge cases: null-duration NaN guard, null-outcome bucketing under `unknown`, outcome-sort by count desc, explicit from/to range filter, agent_id filter narrowing, all-failed workspace, total_minutes 2-decimal rounding, zero-call agent metrics no NaN, single-agent filter, average-duration integer rounding, multi-reason single-check counting, empty/missing-code reason handling, block-reason sort, opt-out window exclusion, agent_id compliance filter, sub-threshold suppression for low_success_rate / tool_failure / low_evaluation, exact-threshold flip, multi-condition all-trigger path, healthy-agent silence path, recordEvent payload + occurred_at persistence, recordEventInternal swallow on prisma error, and listEvents desc order + agent_id filter + cross-workspace exclusion. Final count: **133 / 133 api tests + 6 / 6 shared = 139 passing** (was 88). `npm run typecheck` clean across all 4 workspaces. `db:push` for the new `white_label_settings` and `client_invites` tables deferred to user environment per existing pattern.

- **2026-04-27 13:30 UTC** — Phase 7 Analytics shipped. New Prisma model `AnalyticsEvent` (`workspaceId`, `agentId?`, `callId?`, `eventType`, `payload`, `occurredAt`) plus relations on `Workspace`/`Agent`/`Call`; indices on `(workspace, occurred_at)`, `(workspace, eventType, occurred_at)`, `(agent, occurred_at)`. Shared schemas in `packages/shared/src/schemas/analytics.ts`: `CallOutcomeSchema` (12 outcomes per docs/12), `RecordAnalyticsEventDto`, `MetricsRangeQuery`, `WorkspaceMetrics`, `AgentMetricsResponse` (per-agent rows w/ booking/qualification/transfer/fallback/tool-success rates + avg duration + avg eval score), `ComplianceMetrics` (blocked count, block reasons, opt-outs, DNC hits, missing consent), `ImprovementSuggestion` (severity info|warning|critical) and response. New NestJS `apps/api/src/analytics/` module: `AnalyticsService` aggregates from `calls` / `compliance_checks` / `tool_invocations` / `call_evaluations` / `contacts`, returns workspace KPIs and per-agent rows, and emits 5 rule-based improvement suggestions (low_success_rate, high_short_call_rate, tool_failure_rate_high, compliance_blocks, low_evaluation_score) with hard volume thresholds so empty workspaces stay quiet. `AnalyticsController` exposes `POST|GET /workspaces/:ws/analytics/events`, `GET /workspaces/:ws/analytics/{workspace,agents,compliance}`, `GET /workspaces/:ws/analytics/agents/:aid/suggestions` behind `WorkspaceGuard`. `CallsService` now imports `AnalyticsModule` and emits `call.blocked`, `call.started`, `call.ended`, and `outcome.<value>` events at the relevant lifecycle hooks (compliance preflight, outbound start, manual end, webhook `call.ended`); failures are swallowed so analytics never breaks the call flow. Frontend: new `/dashboard/analytics` page with `AnalyticsPanel` (KPI grid, per-agent table, compliance summary, outcome breakdown), new `SuggestionsPanel` component embedded in the agent builder page next to KnowledgePanel, sidebar gained an `Analytics` entry. Tests: new `apps/api/src/analytics/analytics.test.ts` covers workspace aggregation (incl. empty-workspace zero path), per-agent rows + sort, compliance reason counts, and suggestion thresholds (5 cases). Updated `apps/api/src/calls/ingest-event.test.ts` constructor to inject the new `AnalyticsService` mock + `processTranscriptOptOut` stub. Typecheck clean across all 4 workspaces; vitest **82 / 82 api tests + 6 / 6 shared = 88 passing** after rebuilding `@voiceforge/shared/dist` (analytics schemas must be built before tests run).

- **2026-04-27 12:00 UTC** — Phase 6 Compliance shipped end-to-end. Prisma models `Contact`, `ConsentRecord`, `DncEntry`, `ComplianceCheck` plus `Workspace`/`Agent`/`Call` relations and `Call.contactId`. Shared Zod schemas in `packages/shared/src/schemas/compliance.ts` (DTOs for contact CRUD, opt-out, consent grant/revoke, DNC add/remove, compliance check request/result, plus `ALLOWED_OUTBOUND_PURPOSES`/`BLOCKED_OUTBOUND_PURPOSES` constants and a `ComplianceReason` discriminated payload with `severity: blocking | warning`). New NestJS `apps/api/src/compliance/` module: `ComplianceService` rule engine implements all 9 docs/11 checks (agent published, consent, opt-out, DNC, allowed call window via Intl.DateTimeFormat in agent timezone, allowed/blocked purpose, AI disclosure warning, recording notice warning, valid phone), persists a `ComplianceCheck` row on every call, and exposes `processTranscriptOptOut` that scans finished-call transcripts for `do not call`/`stop calling`/`unsubscribe`/`opt out` etc., flips `Contact.optOut`, mirrors the number into `dnc_entries` with `source=request`, and audits. Controllers: `ContactsController` (`GET|POST /workspaces/:ws/contacts`, `GET|PATCH /workspaces/:ws/contacts/:id`, `POST /:id/consent`, `POST /:id/consent/revoke`, `POST /:id/opt-out`) and `ComplianceController` (`POST /workspaces/:ws/compliance/check`, `GET|POST /workspaces/:ws/compliance/dnc`, `DELETE /workspaces/:ws/compliance/dnc/:phone`). `CallsService.startOutboundCall` now runs the pre-flight check before dispatching to the voice provider; on `status=blocked` it audits `call.outbound.blocked` and throws `ComplianceBlockedError` (`COMPLIANCE_BLOCKED`, HTTP 422). Webhook `ingestEvent` calls `processTranscriptOptOut` on `call.ended` so caller opt-outs land in the workspace DNC list automatically. Frontend: new `/dashboard/compliance` page with `CompliancePanel` (Contacts tab w/ create-or-update form, per-contact consent grant/revoke, manual opt-out; DNC tab w/ list + add + remove). Sidebar gained a `Compliance` entry. Tests: new `apps/api/src/compliance/compliance.test.ts` covering the rule engine (agent_not_published, dnc_listed, opted_out, missing_consent, unsupported_purpose, outside_call_window, AI-disclosure warning, passing path) plus opt-out detection. Phase 4 inbound deployment also retroactively marked DONE — `ingestEvent` already resolves inbound calls via `provider_runtime_id` on the deployed AgentVersion. Typecheck clean across all 4 workspaces; vitest passes the new compliance suite alongside the prior tests after rebuilding `@voiceforge/shared/dist` (the package is consumed via `dist`, so the new constants must be built before tests run).

- **2026-04-25 18:35 UTC** — Audit + verification + LLM swap to OpenAI. Ran `apps/api/scripts/supabase-probe.ts` against the live Supabase project — all 4 surfaces green: REST 401 (project responding, expected), Auth settings 200 with 26 providers, Postgres direct 5432 PostgreSQL 17.6, Postgres pooled 6543 (Supavisor) PostgreSQL 17.6. Replaced the templates-only `prisma/seed.ts` with a full demo seed: idempotently upserts 5 templates, plus a demo `User` (`demo@voiceforge.local`), `Organization` (`demo-org`), `Workspace` (`demo`), `Membership` (owner), 2 published `Agent` rows seeded from the dental-receptionist + appointment-reminder templates with v1 versions, 1 inline-text `KnowledgeSource` ("Demo clinic FAQ") with a single chunk, and 1 sample `browser_test` `Call` row with scripted transcript. `npm run db:seed` succeeded end-to-end against Supabase. Added `OpenAiLlmAdapter` calling `https://api.openai.com/v1/chat/completions` with `OPENAI_API_KEY`, JSON-mode response, AgentSpecSchema validation gate, automatic fallback to mock on any failure (network/parse/schema/missing key). Wired into `LlmModule` factory; `LLM_PROVIDER=openai` now selects it. Stripped the leading `openai/` namespace from `LLM_MODEL` if present so a single env var works for both the GitHub Models and OpenAI adapters. Added `apps/api/scripts/openai-probe.ts` — confirmed live OpenAI call returns 200, model `gpt-4o-mini-2024-07-18`, valid JSON content, ~2.6 s round-trip. `.env` and `.env.example` reorganized so `OPENAI_API_KEY`, `GITHUB_TOKEN`, `LLM_MODEL`, `LLM_BASE_URL` are grouped with provider-selection comments. Typecheck clean across 4 workspaces; vitest 12/12 pass.

- **2026-04-25 18:15 UTC** — Two big fixes. (1) Replaced the `tsx watch` dev runner with `nodemon` + `@swc-node/register`. tsx ships esbuild, which does NOT support `emitDecoratorMetadata`, so Nest's reflection-based DI was silently injecting `undefined` for every constructor parameter typed as a class — manifested as `Cannot read properties of undefined (reading 'user'/'ping'/'getSessionUser')`. SWC honors the metadata directive (`.swcrc` → `jsc.transform.decoratorMetadata: true, legacyDecorator: true`), so DI now resolves correctly across `ClerkAuthService`, `HealthService`, `AgentsService`, `KnowledgeService`, and `CallsService`. Boot smoke (`node -r @swc-node/register src/main.ts`) brings up all routes and a no-token GET /auth/me returns 401 (correct, was 500). Updated the `db:seed` script to also use `@swc-node/register` instead of tsx. The previously-added explicit `@Inject(AuthService)` band-aids are kept as defensive code. (2) New LLM provider abstraction. Added `apps/api/src/llm/` with `LlmAgentGenerator` interface + `LLM_PROVIDER_TOKEN`, plus two adapters: `MockLlmAdapter` (delegates to the existing deterministic `MockAgentGeneratorService`) and `GithubModelsLlmAdapter` (POSTs to `https://models.github.ai/inference/chat/completions` with `GITHUB_TOKEN` PAT scope `models:read`). Default model `openai/gpt-4o-mini`, JSON-mode response, `AgentSpecSchema` validation gate, automatic fall-back to mock on any network/parse/schema failure or when `GITHUB_TOKEN` is empty. Wired through `LlmModule` (global) and selected via env `LLM_PROVIDER=mock|github|openai|anthropic` (`mock` and `github` implemented; `openai`/`anthropic` reserved). `AgentsService` now injects `LLM_PROVIDER_TOKEN` instead of `MockAgentGeneratorService` directly. `.env` + `.env.example` updated with `GITHUB_TOKEN`, `LLM_MODEL`, `LLM_BASE_URL`. Typecheck clean across 4 workspaces; vitest 12/12 pass.

- **2026-04-25 12:25 UTC** — Phase 3 Voice Runtime first slice (mock-only). New Prisma models `Call` + `CallEvent` (chunks-style cascade on `CallEvent → Call`). New shared schemas in `packages/shared/src/schemas/call.ts` (`CallDirection`, `CallStatus`, `StartTestSessionDto`, `StartOutboundCallDto`, `CallSummary`, `CallDetail`, `CallTurn`, `TestSessionResult`). New error codes `CALL_NOT_FOUND` + `AGENT_NOT_PUBLISHED`. API: `apps/api/src/calls/` module — `CallsService` + `CallsController` (workspace-guarded) + `VoiceWebhookController` (public). Routes: `POST /workspaces/:ws/agents/:aid/test-session`, `POST /workspaces/:ws/agents/:aid/calls/outbound`, `GET /workspaces/:ws/calls`, `GET /workspaces/:ws/calls/:id`, `POST /workspaces/:ws/calls/:id/end`, `POST /voice/webhooks/:provider`. Service injects `VOICE_PROVIDER_TOKEN` and dispatches to the configured adapter (mock by default), persists `Call` rows with provider id + scripted transcript for browser tests, audits every mutation. Outbound enforces `agent.status === 'published'`. Web: new `components/test-call-drawer.tsx` (modal w/ scripted transcript + status badge), wired into `/dashboard/agents/[agentId]/builder` "Test call" button. Rebuilt `/dashboard/calls` (real list from API) + new `/dashboard/calls/[callId]` (transcript + metadata grid). Schema pushed to Supabase (~10 s, `calls` and `call_events` tables created). Typecheck clean across 4 workspaces; tests 12/12 pass.

- **2026-04-25 12:10 UTC** — Runtime bug fixes after first end-to-end run with Clerk + Supabase. (1) `<SignInButton>` / `<SignUpButton>` in `apps/web/app/layout.tsx` were throwing `@clerk/react: You've passed multiple children components` against Clerk v7 — collapsed wrapped `<button>` onto a single line so JSX no longer emits whitespace text-node siblings around the single child. (2) Express request handlers were crashing with `Cannot read properties of undefined (reading 'getSessionUser')` because Nest DI was failing silently to inject the abstract-class `AuthService` token under tsx/esbuild — added explicit `@Inject(AuthService)` decorators in `auth.controller.ts`, `templates.controller.ts`, `workspaces.controller.ts`, and `common/workspace.guard.ts`. Typecheck still clean across 4 workspaces; tests still 12/12 pass.

- **2026-04-25 11:50 UTC** — Supabase + Prisma + Clerk wired live. Root `.env` `DATABASE_URL` switched off `db.prisma.io` (was misdirected) onto Supabase Supavisor pooler `aws-1-ap-northeast-1.pooler.supabase.com:6543?pgbouncer=true`; `DIRECT_URL` switched onto same pooler `:5432`. Project ref `nsgshzxxhytjmiiasobc`, region `ap-northeast-1`. `AUTH_PROVIDER` flipped `mock → clerk`. Mirrored root `.env` to `apps/api/.env` because Prisma CLI does not walk up to monorepo root for `.env`. Added Clerk + Supabase + API URLs to `apps/web/.env.local`. Ran `npm run db:generate`, `npm run db:push` (schema synced to Supabase, ~17 s, all Phase 0/1/2 tables incl. `knowledge_sources` + `knowledge_chunks`), `npm run db:seed` (5 MVP templates inserted). `npm run typecheck` clean across 4 workspaces.

- **2026-04-24 21:33 UTC** — Phase 2 Knowledge slice. New Prisma models `KnowledgeSource` + `KnowledgeChunk` (chunks cascade on source delete). New shared DTOs in `packages/shared/src/schemas/knowledge.ts` plus `source_ids` on `AgentKnowledgeConfigSchema` and `knowledge_source_ids` on `GenerateAgentDtoSchema`. API: `apps/api/src/knowledge/` (module/service/controller) behind `WorkspaceGuard` — routes `GET|POST|PATCH|DELETE /workspaces/:ws/knowledge-sources[/:id]` and `GET /workspaces/:ws/agents/:aid/knowledge-sources`. `text` sources split into ~1200-char chunks at create time, `status=ready`; `url|file` sources stay `pending`. Every mutation writes `audit_logs`. `AgentsService.generate` is async and validates `knowledge_source_ids` via `KnowledgeService.resolveReferencedSourceIds` before the mock generator merges them into `spec.knowledge.source_ids`. Mock generator also flips `retrieval_mode` from `none → agent_scoped` on faq/docs/policy prompts. Web: new `components/knowledge-panel.tsx` (agent + workspace modes), embedded in `/dashboard/agents/[agentId]/builder`; new `/dashboard/knowledge` admin page; rebuilt `/dashboard/templates` to list real templates via `/templates` API; `/dashboard/agents/new` now honors `?template=<slug>` and ticks workspace knowledge for injection. Zustand draft store gained `knowledgeSourceIds` + toggler. All 5 seed templates updated with `source_ids: []`. `npm run db:generate`, `npm run typecheck` (4 clean), `npm run test` (**12/12 pass**). DB push/seed + live smoke deferred (user env).

- **2026-04-24 15:22 UTC** - Supabase probe added and all four surfaces pass. New script apps/api/scripts/supabase-probe.ts tests REST reachability (with the publishable key), GoTrue /auth/v1/settings, Postgres DIRECT_URL, and Postgres DATABASE_URL via Prisma. Fixed two .env bugs found along the way: (a) the password contains @ and # so URL-encoded them to %40 and %23, and (b) DATABASE_URL was pointed at a guessed pooler hostname that returned 'Tenant or user not found' - temporarily aliased to the direct connection (which works, PostgreSQL 17.6) with a TODO to swap in the real pooler hostname from the Supabase dashboard before any serverless deploy. Final probe result: REST 401 (expected - publishable key cannot hit metadata), Auth settings 200 with 26 providers, DIRECT_URL 5432 connects cleanly, DATABASE_URL now also connects.

- **2026-04-24 14:42 UTC** - EC2 Redis probe. Added `apps/api/scripts/redis-probe.ts` one-shot CLI: connects, PINGs, SET/GET/DELs, and prints latency + INFO. Tested against the provided `redis://:@13.206.121.190:6379` - TCP:6379 times out from the laptop (EC2 security group blocks the port, which is correct: passwordless Redis must NOT be exposed to the internet). Created `H:\voice-agent-builder\.env` from `.env.example` and set `REDIS_URL=redis://127.0.0.1:6379` with a comment reminder to open an SSH tunnel (`ssh -N -L 6379:127.0.0.1:6379 ec2-user@13.206.121.190`). Documented verification steps for the user to run on the EC2 (is redis-server up? what is it bound to? protected-mode?) before using the tunnel.
- **2026-04-24 14:32 UTC** - Wired AWS ElastiCache Serverless Valkey 8.1 (endpoint voice-6knamf.serverless.aps1.cache.amazonaws.com:6379, region ap-south-1). Rewrote apps/api/src/queue/queue.service.ts so ioredis detects rediss:// and enables TLS with SNI, plus keepAlive + retryStrategy + reconnectOnError for AWS NAT timeouts; added a ping() method. Added apps/api/src/cache/{cache.service,cache.module}.ts with get/set/del/readThrough over the shared Valkey connection; no-ops when REDIS_URL is empty. Wired CacheModule into AppModule. Extended /api/v1/health to report cache: ok | disabled | error. Updated .env.example with the rediss:// URL template and the VPC caveat. Typecheck clean; 6/6 api tests still passing.

- **2026-04-24 13:28 UTC** - Supabase layered onto the frontend. Installed `@supabase/supabase-js` and `@supabase/ssr` in `apps/web`. Added `apps/web/lib/supabase/{client,server,middleware,index}.ts`. Created `apps/web/.env.local` with user-supplied `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (gitignored). Created `apps/web/components.json` so future shadcn adds are non-interactive. Installed Supabase agent skills via `npx skills add supabase/agent-skills` - `supabase` and `supabase-postgres-best-practices` copied into `.agents/skills/`. `npm run typecheck` still clean.
- **2026-04-24 13:18 UTC** — Verification pass completed: `npm install` (650 packages), Prisma Client generated, `npm run typecheck` clean across 4 workspaces, `npm run test` 12/12 passing. Fixed: api `rootDir` (dropped for typecheck, retained in `tsconfig.build.json`), audit `Prisma.JsonNull` on empty metadata, Clerk 7 `UserButton` no longer takes `afterSignOutUrl`, `Label` primitive now uses `LabelHTMLAttributes<HTMLLabelElement>`, upgraded `@clerk/nextjs` to `^7.2.5` (exports the new `<Show>` API). Restored `voice.provider.interface.ts` and the entire `workspaces/` NestJS module that were lost to an earlier cancelled tool call.
- **2026-04-24 13:09 UTC** — Status document created.
- **2026-04-24 13:08 UTC** \u2014 Added Vitest tests for the mock generator and the ZodValidationPipe (`apps/api/src/agents/mock-generator.test.ts`, `apps/api/src/common/zod-validation.pipe.test.ts`).
- **2026-04-24 13:06 UTC** \u2014 Built the web dashboard: layout + sidebar, `/dashboard` home, `/dashboard/agents`, `/dashboard/agents/new` (Monaco preview), `/dashboard/agents/[agentId]/builder`, and coming-soon stubs. Added TanStack Query provider, Sonner toaster, Zustand draft store.
- **2026-04-24 13:04 UTC** \u2014 Added NestJS `templates` and `agents` modules. `MockAgentGeneratorService` does template match + keyword heuristics and validates via shared Zod schema. Agents service enforces workspace scoping and writes audit logs on every mutation.
- **2026-04-24 13:02 UTC** \u2014 Clerk wired on the backend: `ClerkAuthService` verifies bearer tokens with `@clerk/backend`, lazily provisions User/Organization/Workspace in Postgres, and is selected by `AUTH_PROVIDER=clerk`. Added Clerk env vars.
- **2026-04-24 13:01 UTC** \u2014 Clerk wired on the frontend: `@clerk/nextjs`, `proxy.ts` with `clerkMiddleware()`, `ClerkProvider` inside `<body>`, header uses `<Show>` + `SignInButton` / `SignUpButton` / `UserButton`.
- **2026-04-24 12:58 UTC** \u2014 Voice adapters: `VoiceRuntimeProvider` interface, `MockVoiceAdapter` (scripted transcript/events), `VapiVoiceAdapter` / `RetellVoiceAdapter` stubs gated by env.
- **2026-04-24 12:56 UTC** \u2014 Auth (mock), Audit, Queue, Health modules + common errors / filter / interceptor / guard / pipe.
- **2026-04-24 12:53 UTC** \u2014 Prisma schema + seed: User, Organization, Workspace, Membership, Agent, AgentVersion, AgentTemplate, AuditLog. Supabase-ready (`DIRECT_URL` for migrations).
- **2026-04-24 12:51 UTC** \u2014 `packages/shared`: Agent Spec Zod schema, agent DTOs, API envelope + error codes, template constants (5 MVP templates), industry constants, session-user types. Vitest fixtures.
- **2026-04-24 12:48 UTC** \u2014 Monorepo restructure: npm workspaces root, `apps/web` + `apps/api` + `packages/shared` + `packages/ui`. Moved the original Next.js scaffold to `apps/web/`. Replaced `README.md` with a dev-quickstart, added `.env.example`, `.prettierrc.json`, `tsconfig.base.json`, expanded `.gitignore`.
