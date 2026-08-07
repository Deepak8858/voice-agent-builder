# VoiceForge AI — Comprehensive Codebase Audit

**Repo:** `Deepak8858/voice-agent-builder` (`main`)
**Stack (actual):** Next.js 16 + React 19 (`apps/web`) · NestJS 10 + Prisma 5 (`apps/api`) · Supabase Postgres · BullMQ/Redis · LiveKit + OpenAI Realtime · `packages/shared` (Zod)
**Method:** static analysis + taint tracking, doc-vs-code delta, config/IaC/CI review, dependency manifest review. Runtime exploitation not performed. Findings are **Confirmed** (code read) unless marked **Suspected**.
**Auditor:** Oz (senior staff engineer + security auditor)

> **Note on prior audits:** `docs/SECURITY_AUDIT.md` and `docs/WEB_SECURITY_AUDIT.md` are dated 2026-05-01 and describe a *Clerk + mock-auth* era. The codebase has since migrated to Supabase auth and remediated most of those items. Section F tracks each prior item's current status; do not treat those documents as current.

---

## Context — Documents Read
`AGENTS.md` (rules), `README.md`, `docs/00_MASTER_CONTEXT.md`, `docs/02_MVP_SCOPE.md`, `docs/17_SECURITY_PRIVACY.md`, `docs/20_IMPLEMENTATION_ROADMAP.md`, `docs/21_TASK_BACKLOG.md`, `docs/22_ACCEPTANCE_CRITERIA.md`, `docs/SECURITY_AUDIT.md`, `docs/WEB_SECURITY_AUDIT.md`, `manifest.json`, plus deep reads of ~40 source files across `apps/api`, `apps/web`, `infra`, and `.github/workflows`. The docs describe a 33-file build pack and TASK-001→TASK-055 backlog; code is treated as source of truth on conflict.

---

# Section A — Executive Summary

**Overall build vs spec: ~92% of the MVP task backlog is implemented.** Contrary to `README.md:105-120` (which claims "Phase 6 onwards is not yet implemented"), Phases 6–10 (compliance, analytics, white-label, billing, hardening) **are present and largely functional** — the README is stale. The codebase is well-structured: a global auth guard, consistent workspace-scoped queries, HMAC-verified provider webhooks, AES-256-GCM encryption at rest, audit logging on mutations, Zod validation at controllers, helmet + CSP, and nginx TLS hardening.

However, two **Critical** issues make it unsafe to ship as-is, plus a set of High/Medium hardening gaps.

**Top 5 risks (security + correctness)**
1. **CRITICAL — Secrets in git:** live Chrome profiles with saved passwords + session cookies committed (`.codex-browser-shots/**`), plus Supabase project ref + pooler DSN (`supabase/.temp/**`).
2. **CRITICAL — SSRF:** the user-configurable webhook tool executor (`apps/api/src/tools/webhook-executor.ts:42`) fetches arbitrary URLs with no allow-listing → cloud-metadata credential theft.
3. **HIGH — SSRF filter bypass:** the CRM executor blocklist (`apps/api/src/tools/crm-executor.ts:39`) is defeated by DNS rebinding and HTTP redirects.
4. **MEDIUM — Open redirect:** OAuth callback trusts `next` (`apps/web/app/auth/callback/route.ts:8,68`).
5. **MEDIUM — Latent unauthenticated user-record tamper:** `SupabaseWebhookController` has no signature verification; currently dead code (unregistered) but a landmine if wired as `@Public()`.

**Top 5 missing / weak features**
1. Retell adapter (spec TASK-030 lists Vapi **and** Retell) — only Vapi/OpenAI-Realtime/LiveKit present.
2. `trust proxy` not set → `audit_logs.ip_address` is unreliable / X-Forwarded-For spoofable behind nginx.
3. Prometheus is internet-exposed without auth via nginx (`infra/nginx/nginx.conf:204`).
4. CI uses long-lived static AWS keys instead of OIDC (`.github/workflows/ci-cd-ec2.yml:80`).
5. Dependency scanning / `pnpm audit` not gated in CI; `pdf-parse` (unmaintained) parses attacker-supplied files.

**1-week "stop the bleeding"**
- Purge browser profiles + `supabase/.temp` from git history; **rotate every exposed credential** (P0).
- Ship a shared `safeFetch()` (https-only, DNS-resolve + private-IP block, no redirects, IP-pinning) and route webhook/CRM/calendar executors through it; block `169.254.169.254` at egress (P0).
- Fix OAuth open redirect; delete/guard the dead Supabase webhook controller.

**3-week "MVP demo" plan**
- Wk1: the P0 list + secret-scanning CI gate (gitleaks) + `pnpm audit`/`osv-scanner` gate.
- Wk2: `trust proxy`, remove public Prometheus, AWS OIDC, nonce-based CSP, crypto-random verification tokens, JWT `aud`/`iss` checks, webhook replay windows.
- Wk3: add Retell adapter (or drop from spec), fill test gaps (webhook idempotency negative paths, compliance-block E2E), update stale README/status docs, reconcile the AWS/Azure/GCP deploy trifurcation.

---

# Section B — Build-vs-Spec Matrix (TASK-001 → TASK-055)

Legend: 🟢 BUILT · 🟡 PARTIAL · 🔴 MISSING · 🟣 STUBBED. "Evidence" cites a representative path; presence marks are confirmed by module/file existence, deep marks by code read.

| TASK | Title | Status | Evidence |
|------|-------|--------|----------|
| 001 | Monorepo | 🟢 | `package.json` workspaces; `pnpm-workspace.yaml` |
| 002 | Next.js frontend | 🟢 | `apps/web/app/**`, `next.config.ts` |
| 003 | NestJS backend | 🟢 | `apps/api/src/app.module.ts` |
| 004 | Postgres/Redis | 🟢 | `apps/api/prisma/schema.prisma`; `queue/queue.service.ts` |
| 005 | CI/CD | 🟢 | `.github/workflows/ci-cd-ec2.yml`, `deploy-gcp.yml` |
| 006 | Auth integration | 🟢 | `auth/supabase-auth.service.ts` (README says "mock" — **stale**) |
| 007 | User sync | 🟢 | `supabase-auth.service.ts:239` + trigger `supabase/migrations/006_*` |
| 008 | Organization CRUD | 🟢 | `workspaces/workspaces.service.ts` |
| 009 | Workspace CRUD | 🟢 | `workspaces/*`; `white-label` client workspaces |
| 010 | Membership roles | 🟢 | `workspace.guard.ts:62`; `Membership` model |
| 011 | Agent tables | 🟢 | `schema.prisma` (Agent/AgentVersion) |
| 012 | Agent Spec Zod schema | 🟢 | `packages/shared/src/schemas/agent-spec.ts` |
| 013 | Prompt→agent generator | 🟢 | `orchestrator/orchestrator.service.ts`, `agents.service.generate` |
| 014 | Agent APIs | 🟢 | `agents/agents.controller.ts` |
| 015 | Builder UI | 🟢 | `apps/web/app/dashboard/agents/[agentId]/builder/page.tsx` |
| 016 | Versioning | 🟢 | `agents.controller.ts:150` createVersion/publish |
| 017 | Template table | 🟢 | `schema.prisma`; `templates/*` |
| 018 | Seed templates | 🟢 | `prisma/seed.ts`; `shared/src/constants/templates.ts` |
| 019 | Template selector UI | 🟢 | `app/dashboard/templates/page.tsx` |
| 020 | Clone template | 🟢 | `templates.service.ts` |
| 021 | Knowledge tables | 🟢 | `schema.prisma` (KnowledgeSource/Chunk) |
| 022 | Manual FAQ | 🟢 | `knowledge.controller.ts:56` |
| 023 | File upload | 🟢 | `knowledge.controller.ts:66` (MIME allow-list + size cap) |
| 024 | Chunking | 🟢 | `knowledge/parsers/file-parser.ts` |
| 025 | Embeddings | 🟢 | `workers/embeddings.worker.ts`; `knowledge/embeddings/openai.embedding.adapter.ts` |
| 026 | Provider adapter interface | 🟢 | `voice/adapters/voice.provider.interface.ts` |
| 027 | Mock provider | 🟣→removed | `config/env.ts:16` ("mock providers are REMOVED") — spec expected mock fallback (AGENTS.md rule 10) |
| 028 | Test session API/UI | 🟢 | `calls/start-test-session.test.ts`; `components/test-call-drawer.tsx` |
| 029 | Webhook endpoint | 🟢 | `calls/voice-webhook.controller.ts` (HMAC verified) |
| 030 | Vapi/Retell adapter | 🟡 | Vapi `voice/adapters/vapi.adapter.ts` ✅; **Retell 🔴 absent** |
| 031 | Calls tables | 🟢 | `schema.prisma` (Call/CallEvent) |
| 032 | Calls APIs | 🟢 | `calls/calls.controller.ts` |
| 033 | Calls UI | 🟢 | `app/dashboard/calls/page.tsx` |
| 034 | Call detail UI | 🟢 | `app/dashboard/calls/[callId]/page.tsx` |
| 035 | Post-call eval | 🟢 | `evaluations/evaluations.service.ts` |
| 036 | Integration model | 🟢 | `schema.prisma` (IntegrationTool) |
| 037 | Webhook tool | 🟢 | `tools/webhook-executor.ts` (⚠ SSRF — F2) |
| 038 | Tool registry | 🟢 | `tools/tools.service.ts:53` |
| 039 | Google Calendar | 🟢 | `tools/executors/google-calendar.executor.ts` |
| 040 | Contacts | 🟢 | `compliance/contacts.controller.ts` |
| 041 | Consent records | 🟢 | `compliance/compliance.service.ts` |
| 042 | DNC/DND | 🟢 | `compliance.service.ts` |
| 043 | Compliance engine | 🟢 | `telephony.service.ts:490` gate on outbound (AGENTS.md rule 3) |
| 044 | Compliance UI | 🟢 | `app/dashboard/compliance/page.tsx` |
| 045 | Event ingestion | 🟢 | `workers/analytics.worker.ts`; `analytics/analytics.service.ts` |
| 046 | Overview dashboard | 🟢 | `components/analytics-panel.tsx` |
| 047 | Agent analytics | 🟢 | `analytics/analytics.service.ts` |
| 048 | White-label settings | 🟢 | `white-label/white-label.service.ts` |
| 049 | Client workspaces | 🟢 | `white-label.service.ts:145` |
| 050 | Agency dashboard | 🟢 | `app/dashboard/clients/page.tsx` |
| 051 | Stripe checkout | 🟢 | `billing/billing.service.ts` + `webhooks/stripe-webhook.service.ts` |
| 052 | Usage metering | 🟢 | `billing.service.getWorkspaceUsage` |
| 053 | Audit logs | 🟢 | `audit/audit.service.ts` (called across services) |
| 054 | Rate limits | 🟢 | `common/rate-limit.guard.ts` (global `APP_GUARD`) |
| 055 | Tests | 🟡 | ~40 `*.test.ts` present; gaps in Section E |

**Doc/code deltas worth flagging:** README status (🟢 vs claim of unbuilt), README "Auth: Mock/Clerk" (now Supabase), README "Voice: Mock provider stubbed" (mocks removed per `env.ts:16`), and AGENTS.md rule 10 ("mock providers when creds absent") is now **contradicted** by the explicit mock removal — a deliberate but undocumented reversal.

---

# Section C — Findings

Severity: **CRITICAL** (RCE/auth bypass/tenant leak) · **HIGH** (data exposure/privesc) · **MEDIUM** (DoS/info leak) · **LOW** (hygiene) · **INFO**.

### FINDING-001 — [CRITICAL] Live browser profiles (passwords + cookies) committed to git
**Area:** Secrets **Location:** `.codex-browser-shots/chrome-profile-*/Default/Login Data`, `.../Login Data For Account`, `.../Network/Cookies` (≈8 profiles, git-tracked) **Spec ref:** AGENTS.md; `docs/17` "exposed integration secrets"
**Issue:** Full Chromium user-data dirs are committed. `Login Data` is a SQLite store of saved credentials; `Cookies` holds session cookies (potentially valid `sb-*-auth-token`). Present in history, so deletion alone won't remediate.
**Impact:** Session/credential theft → account takeover and lateral movement.
**Fix:** Purge with `git filter-repo --path .codex-browser-shots --invert-paths` (+ `supabase/.temp`), force-push, invalidate clones; **rotate all exposed credentials/sessions**; gitignore `**/Default/`, `*.sqlite`; add gitleaks pre-commit + CI gate. **Effort:** M

### FINDING-002 — [CRITICAL] Unrestricted SSRF in webhook tool executor
**Area:** Input Validation / SSRF **Location:** `apps/api/src/tools/webhook-executor.ts:42`; reachable via `tools/tools.service.ts:53-58` (`webhook`/`http_post`/`http_get`) → `tools.controller` invoke **Spec ref:** `docs/17` "webhook spoofing"; AGENTS.md rule 5
**Issue:** `fetch(webhookConfig.url, …)` uses a fully tenant-controlled URL/method/headers with **no host/scheme validation and follows redirects**. Unlike `crm-executor.ts`, there is no blocklist at all.
**Impact:** On GCP (`deploy-gcp.yml`) hitting `http://169.254.169.254/computeMetadata/v1/.../token` returns the instance service-account token → cloud compromise; also internal port-scan / reach Redis/Grafana/other tenants.
**PoC:**
```
POST /api/v1/workspaces/{ws}/tools {"tool_type":"http_get","enabled":true,
 "config":{"url":"http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token","method":"GET","headers":{"Metadata-Flavor":"Google"}},"input_schema":{"type":"object"}}
POST /api/v1/workspaces/{ws}/tools/{id}/invoke {"arguments":{}}
```
**Fix:** Centralized `safeFetch()`: https-only, resolve DNS and reject any private/loopback/link-local/ULA/`169.254/16`/`100.64/10`/IPv4-mapped address, `redirect:'error'`, connect to the validated IP (defeat rebinding). Block metadata IP at egress firewall. **Effort:** M

### FINDING-003 — [HIGH] SSRF allow-list bypass in CRM executor
**Area:** SSRF **Location:** `apps/api/src/tools/crm-executor.ts:26-47` (`isUrlBlocked`) **Spec ref:** `docs/17`
**Issue:** Blocklist only regex-matches the literal hostname — no DNS resolution — and `httpPost` (line 198) uses `fetch`, which follows redirects. A domain resolving to `169.254.169.254`, or a public host that 302s internally, bypasses it. IPv4-mapped IPv6, decimal/octal IPs, and CGNAT are uncovered.
**Impact:** Same class as F2 for `generic`/`salesforce` CRM paths.
**Fix:** Replace with the resolve-and-validate + pin-IP + no-redirect `safeFetch()` from F2; share across executors. **Effort:** M

### FINDING-004 — [MEDIUM] Open redirect via OAuth `next` parameter
**Area:** AuthZ / Redirect **Location:** `apps/web/app/auth/callback/route.ts:8,61,68` **Spec ref:** `docs/WEB_SECURITY_AUDIT.md` §8 (open-redirect class)
**Issue:** `next` from the query is used in `NextResponse.redirect(new URL(next, req.url))` with no same-origin check; `new URL("https://evil.com", base)` resolves off-origin.
**Impact:** Phishing / OAuth-token relay to attacker origin.
**Fix:** Accept only relative same-origin paths (`^/(?!/)`), else fall back to `/dashboard`; apply to onboarding + final redirects. **Effort:** S

### FINDING-005 — [MEDIUM] Latent unauthenticated user-record tamper (dead webhook controller)
**Area:** Webhook / AuthN **Location:** `apps/api/src/auth/supabase-webhook.controller.ts` **Spec ref:** `docs/17` "webhook signature verification"
**Issue:** Reads `req.body` with **no signature verification**; `handleDelete` rewrites a user's email and nulls `authUserId` (account lockout/takeover). **Confirmed** it is not imported by any module (grep: only self-references) → currently unrouted dead code, so not presently exploitable. It is also *not* `@Public()`, so if wired it would be blocked by the global guard — but sibling webhooks are `@Public()`, so a future "make it work" change would expose it.
**Impact:** If wired as `@Public()`: unauthenticated arbitrary user-record mutation.
**Fix:** Delete the file, or (if needed) verify Supabase webhook signature/secret before processing and add idempotency. **Effort:** S

### FINDING-006 — [MEDIUM] Supabase project ref + pooler DSN committed
**Area:** Secrets **Location:** `supabase/.temp/pooler-url`, `.../project-ref`, `linked-project.json`
**Issue:** Production project ref, org id, region and pooled DB DSN (no password) committed — precise target map for the DB endpoint/project.
**Fix:** Remove + gitignore `supabase/.temp/`; ensure DB requires password + network allow-list; rotate DB password; confirm no `service_role` key transited these files. **Effort:** S

### FINDING-007 — [MEDIUM] Unauthenticated Prometheus exposed to the internet
**Area:** AuthN / Info leak **Location:** `infra/nginx/nginx.conf:204-211`; `infra/docker/docker-compose.prod.yml:142`
**Issue:** `/prometheus/` is proxied publicly; Prometheus has no built-in auth. (Grafana at `/grafana/` has login.)
**Impact:** Discloses internal metrics/targets/hostnames; recon aid.
**Fix:** Drop the public location (scrape over the internal network) or gate with `auth_request`/basic-auth + `METRICS_SCRAPE_TOKEN`. **Effort:** S

### FINDING-008 — [MEDIUM] Weak RNG for phone-number verification token
**Area:** Crypto **Location:** `apps/api/src/telephony/telephony.service.ts:1212-1214` (`Math.random()+Date.now()`)
**Issue:** Non-cryptographic PRNG for `verificationToken`. (Contrast: `white-label.service.ts:286` correctly uses `randomBytes(24)`.)
**Impact:** Predictable ownership-verification token (Suspected — depends on downstream check).
**Fix:** `crypto.randomBytes(32).toString('base64url')`. **Effort:** S

### FINDING-009 — [MEDIUM] Permissive script CSP (`'unsafe-inline' 'unsafe-eval'`)
**Area:** Headers **Location:** `apps/web/next.config.ts:14` **Spec ref:** `docs/WEB_SECURITY_AUDIT.md` §2
**Issue:** `script-src 'self' 'unsafe-eval' 'unsafe-inline' …` largely negates CSP as XSS mitigation. Monaco needs `'unsafe-eval'`/worker blobs, but `'unsafe-inline'` for scripts is avoidable.
**Fix:** Nonce/hash-based script CSP (Next nonces); drop script `'unsafe-inline'`; scope `'unsafe-eval'` to the Monaco worker. **Effort:** M

### FINDING-010 — [MEDIUM] Long-lived static AWS keys in CI (no OIDC)
**Area:** Supply Chain **Location:** `.github/workflows/ci-cd-ec2.yml:80-82`
**Issue:** `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` instead of GitHub OIDC federation.
**Fix:** `configure-aws-credentials` with `role-to-assume` (OIDC), scoped to ECR push + deploy; delete static keys. **Effort:** M

### FINDING-011 — [MEDIUM] Reverse-proxy trust not configured (`trust proxy` unset)
**Area:** Logging / AuthZ **Location:** `apps/api/src/main.ts` (no `app.set('trust proxy', …)`); `nginx.conf:163` sets `X-Forwarded-For`
**Issue:** Express isn't told to trust the proxy, so `req.ip` reflects the nginx container, and any `X-Forwarded-For` used for audit/IP logging is client-spoofable.
**Impact:** Inaccurate/forgeable `audit_logs.ip_address`; weakens forensic value and any IP-based logic.
**Fix:** Set a bounded `trust proxy` (e.g. number of known proxies) and derive client IP from it consistently. **Effort:** S

### FINDING-012 — [MEDIUM] SCP deploy disables host-key verification
**Area:** Supply Chain / MITM **Location:** `.github/workflows/ci-cd-ec2.yml:199,202` (`-o StrictHostKeyChecking=no`), line 195 `ssh-keyscan`
**Issue:** First-seen host keys trusted; MITM of the deploy channel could substitute compose/nginx configs delivered to prod.
**Fix:** Pin the EC2 host key as a secret; pre-populate `known_hosts`; remove `StrictHostKeyChecking=no`. **Effort:** S

### FINDING-013 — [LOW] Timing-unsafe secret comparisons
**Area:** AuthN **Location:** `apps/api/src/auth/internal-auth.guard.ts:46` (`provided !== expected`); `common/metrics.controller.ts:20` (`auth !== expected`)
**Issue:** Non-constant-time comparison of the internal key / metrics token. (Providers correctly use `timingSafeEqual` in `vobiz.provider.ts:225` and `voice-webhook.controller.ts:40`.)
**Fix:** `crypto.timingSafeEqual` over fixed-length buffers. **Effort:** S

### FINDING-014 — [LOW] No replay/timestamp protection on Vapi voice webhook
**Area:** Webhook **Location:** `apps/api/src/calls/voice-webhook.controller.ts:39`
**Issue:** HMAC is verified (good) but there's no signed-timestamp freshness window, so a captured request is replayable. (Vobiz does this at `vobiz.provider.ts:150`.)
**Fix:** Require and verify a signed timestamp within a short window; dedupe by event id. **Effort:** S

### FINDING-015 — [LOW] Internal error text leaked into SSE stream
**Area:** Logging / Info leak **Location:** `apps/api/src/agents/agents.controller.ts:116` (`error: String(err)`)
**Issue:** The streaming generator emits raw error text to the client, bypassing the prod-safe `HttpExceptionFilter`.
**Fix:** Emit a generic message; log details server-side. **Effort:** S

### FINDING-016 — [LOW] `reindex`/`backfill` accept `sourceId` without ownership check
**Area:** AuthZ (IDOR) **Location:** `apps/api/src/knowledge/knowledge.controller.ts:154-169`
**Issue:** `WorkspaceGuard` verifies workspace membership, but `sourceId` is enqueued without confirming it belongs to that workspace.
**Impact:** Low — triggers embedding regeneration for a source id; confirm the worker scopes by workspace.
**Fix:** Validate `source.workspaceId === workspaceId` before enqueue. **Effort:** S

### FINDING-017 — [LOW] JWT audience/issuer not validated
**Area:** AuthN **Location:** `apps/api/src/auth/supabase-auth.service.ts:119`
**Issue:** `jwt.verify` pins `algorithms:['HS256']` (good — blocks `alg=none`/confusion) but omits `audience`/`issuer`.
**Fix:** Add `audience:'authenticated'` and the Supabase `issuer`. **Effort:** S

### FINDING-018 — [LOW] Hardcoded development encryption key
**Area:** Secrets **Location:** `apps/api/src/security/encryption.service.ts:67`
**Issue:** Constant dev key when `ENCRYPTION_KEY` unset (prod correctly refuses to boot — `main.ts:11`). Risk is dev-data portability/confusion.
**Fix:** Generate an ephemeral per-process dev key instead of a committed constant. **Effort:** S

### FINDING-019 — [INFO] Hardcoded AWS account IDs / self-signed cert fallback
**Area:** Config **Location:** `docker-compose.prod.yml:22,56` (ECR account `393060838606`); `ci-cd-ec2.yml:238-244` (mints self-signed cert if missing)
**Issue:** Account-id disclosure; silent TLS-trust downgrade to a self-signed cert.
**Fix:** Externalize account ids; fail the deploy if real certs are absent. **Effort:** S

### FINDING-020 — [INFO] AGENTS.md rule 10 contradicted (mocks removed)
**Area:** Code Quality / Spec **Location:** `apps/api/src/config/env.ts:16`
**Issue:** "mock providers are REMOVED" conflicts with AGENTS.md rule 10 ("mock external providers first if credentials unavailable"). Deliberate but undocumented; makes local/dev runs require real provider creds.
**Fix:** Update AGENTS.md/README to record the reversal, or reintroduce a guarded mock path for credential-less dev. **Effort:** S

---

# Section D — Missing / Stubbed Features

- **TASK-030 Retell adapter — 🔴 MISSING.** Spec (`docs/21` Epic 6) lists "Vapi/Retell adapter"; only `voice/adapters/vapi.adapter.ts`, `openai-realtime.adapter.ts`, and LiveKit exist. *Required behavior:* a `RetellAdapter implements VoiceProvider` behind `voice/voice-provider.registry.ts`. *Acceptance (`docs/22`):* test call produces transcript via the selected provider. *Suggested:* `apps/api/src/voice/adapters/retell.adapter.ts` + registry entry + `.env` keys. Alternatively drop Retell from the spec.
- **TASK-027 Mock provider — 🟣 removed.** `env.ts:16` removes mocks; AGENTS.md rule 10 expected a mock fallback. Decide: document the reversal (F020) or reintroduce a dev-only mock provider.
- **TASK-055 Tests — 🟡 partial.** See Section E for specific gaps.

No other backlog task was found MISSING; every epic maps to a present module. (Presence confirmed by file tree; business-logic depth spot-confirmed for auth, tools, telephony, billing, compliance, white-label.)

---

# Section E — Test Gaps

Required per `docs/19_TESTING_QA.md` vs. present `*.test.ts`:

| Required test | Exists? | Notes |
|---|---|---|
| Agent Spec validation | 🟢 | `packages/shared/src/schemas/agent-spec.test.ts` |
| Compliance rules | 🟢 | `compliance/compliance.test.ts`, `erasure.service.test.ts`, `retention.service.test.ts` |
| Workspace authorization | 🟢 | `common/workspace.guard.test.ts`, `auth/internal-auth.guard.test.ts` |
| Tool execution | 🟢 | `tools/tools.service.test.ts`, `webhook-executor.test.ts`, `crm-executor.test.ts` |
| Billing usage | 🟢 | `billing/billing.service.test.ts`, `webhooks/stripe-webhook.service.test.ts` |
| Webhook idempotency | 🟡 | Stripe idempotency covered; **no explicit dedupe/replay test** for telephony/voice webhooks (`calls/ingest-event.test.ts` exists but assert replay rejection) |

**Recommended additions (negative paths):**
- SSRF rejection tests for `webhook-executor`/`crm-executor` once `safeFetch()` lands (assert `169.254.169.254`, DNS-rebind, redirect-to-internal are all blocked).
- Compliance-block E2E: outbound call with missing consent is rejected end-to-end (`telephony.service.startOutboundCall` → `ComplianceBlockedError`).
- Cross-tenant authorization test asserting every workspace-scoped query filters by `workspaceId` (guards the systemic risk in Section G).
- Open-redirect test for `auth/callback` `next`.

---

# Section F — Prior Audit Status

`docs/SECURITY_AUDIT.md` (NestJS) items:
- 1.1 Metrics public — **FIXED**: `metrics.controller.ts:20` now requires `METRICS_SCRAPE_TOKEN` bearer (⚠ non-constant-time compare, F013).
- 1.2 Auth brute-force — **OBSOLETE/FIXED**: mock `/auth/login|signup` removed; auth is Supabase-side; global `RateLimitGuard`.
- 1.3 / 5.1 Voice webhook unauthenticated — **FIXED**: HMAC + `timingSafeEqual` (`voice-webhook.controller.ts:39-42`); residual replay gap (F014).
- 2.1 Billing usage ignores workspace param — **FIXED**: `billing.controller.ts:54-63` uses `workspaceId`.
- 4.1 Billing raw `req.body` — **FIXED**: `ZodValidationPipe(CreateCheckoutSessionDtoSchema)` at `billing.controller.ts:69`.
- 4.2 Agent flow unvalidated — **FIXED**: `UpdateFlowDtoSchema` Zod (`agents.controller.ts:49-52,182`).
- 6.1 Upload trusts mime/filename — **FIXED**: allow-list + `originalname` sanitized (`knowledge.controller.ts:77-85`).
- 7.1 Mock auth unsigned cookie — **OBSOLETE**: `mock-auth.service.ts` removed; Supabase JWT (`supabase-auth.service.ts:119`).
- 8.1 RateLimitGuard never applied — **FIXED**: global `APP_GUARD` (`app.module.ts:88`).
- 8.2 SkipRateLimit broken — **FIXED**: `SetMetadata` factory (`rate-limit.guard.ts:32`).
- 9.1 CORS credentials+dynamic origin — **PARTIAL**: explicit list used, but the "non-empty in prod" assertion is dead code because a localhost default is always injected (`main.ts:46-51`) — tighten.
- 10.1 Error leakage — **FIXED**: prod-sanitized (`http-exception.filter.ts:52`), except SSE path (F015).
- 11.1 Stripe URL open redirect — **FIXED**: allow-list `isTrustedCheckoutUrl` (`app/api/billing/checkout/route.ts:23`).
- 11.2 White-label URL/domain unvalidated — **FIXED**: `isValidLogoUrl`/`isValidDomain` (`white-label.service.ts:24-35,59-74`).
- 12.1 Invite IDOR (no email check) — **FIXED**: `actor.email !== invite.email` → Forbidden (`white-label.service.ts:370`).

`docs/WEB_SECURITY_AUDIT.md` items: CSP/headers — **FIXED** (present in `next.config.ts`, but permissive, F009); middleware auth — **PRESENT** (`middleware.ts`, cookie-presence gate + layout/API enforcement); Zod on forms — **largely FIXED** (react-hook-form + shared Zod in use); billing open redirect — **FIXED** (allow-list); knowledge search still GET (LOW, PII-in-logs — still open, minor).

**New issues the prior audits missed:** F001 (committed browser profiles), F002/F003 (tool SSRF), F005 (dead unauth webhook), F006 (supabase temp DSN), F007 (public Prometheus), F011 (trust proxy), F010/F012 (CI supply chain).

---

# Section G — Operational Health & Architecture Risks

**Architecture-level (systemic):**
1. **Egress is not centrally controlled.** SSRF handling is duplicated and inconsistent (robust-ish CRM, absent webhook, N/A calendar). A single hardened `safeFetch()` for all tenant-influenced outbound calls is the highest-leverage fix.
2. **Secret hygiene / repo discipline.** Committed profiles + temp files indicate no secret-scanning gate and over-broad `git add`. Add gitleaks pre-commit + CI; tighten `.gitignore`.
3. **Tenant isolation is app-layer.** Authorization is consistently `WorkspaceGuard` + `where:{…, workspaceId}` (good), with RLS (`supabase/migrations/003,008,20260531…`) as defense-in-depth. Because the API uses privileged DB access, a single missing `where` = cross-tenant leak → add automated coverage (Section E) and keep RLS enabled.
4. **Deploy trifurcation (AWS EC2 + Azure Terraform + GCP workflow)** raises misconfig odds. Standardize on one target.

**Ops specifics:**
- **Backup/recovery:** `scripts/backup-validation.js` + `docs/35_BACKUP_RECOVERY.md` present — **Suspected valid**, not runtime-verified.
- **Runbook:** `docs/RUNBOOK.md` present; not audited line-by-line this pass.
- **k6 thresholds:** `k6/*.js` + `load-tests/k6/*` present; reachability not runtime-verified (**Suspected**).
- **Alerting/PromQL:** `infra/docker/prometheus/prometheus.yml` + Grafana dashboards present; PromQL validity not runtime-verified, and Prometheus itself is publicly exposed (F007).
- **Observability:** OTel started in `app.module.ts:4-5`; metrics gated by token; health endpoint present (`health/health.controller.ts`).

---

# Section H — Prioritized Backlog

**P0 — this week (security + demo blockers)**
1. Purge `.codex-browser-shots/**` and `supabase/.temp/**` from history; rotate all exposed credentials (F001, F006).
2. Ship `safeFetch()` and route webhook/CRM/calendar executors through it; block metadata IP at egress (F002, F003).
3. Fix OAuth open redirect (F004); delete/guard dead Supabase webhook (F005).
4. Add gitleaks + `pnpm audit`/`osv-scanner` CI gates.

**P1 — next 2 weeks**
5. `trust proxy` (F011); remove public Prometheus (F007); AWS OIDC (F010); pin SSH host key (F012).
6. Nonce-based CSP (F009); crypto-random verification tokens (F008); JWT `aud`/`iss` (F017); webhook replay windows (F014); constant-time compares (F013).
7. Make prod require non-empty `ALLOWED_ORIGINS` (F/CORS); sanitize SSE errors (F015); ownership-check on reindex (F016).

**P2 — post-MVP hardening**
8. Add Retell adapter or amend spec (D/TASK-030); reconcile mock-provider policy vs AGENTS.md (F020).
9. Fill test gaps (Section E); replace `pdf-parse`; enable Dependabot.
10. Consolidate to one deploy target; verify RLS coverage on all tables.

**P3 — tech debt / docs**
11. Update README status + stack table (stale "Phase 6+ not implemented", "Clerk/Mock auth", "mock voice").
12. Convert knowledge search GET→POST (PII in logs); externalize hardcoded account ids (F019).

---

## Guardrails Compliance
Every finding cites `file_path:line_number`. **Confirmed** = code read this session; **Suspected** = not runtime-verified (F008 downstream check; backup/k6/PromQL validity in Section G). No invented endpoints/files. `SupabaseWebhookController` reachability was verified before scoring (F005). Where code contradicts docs (README status, AGENTS.md rule 10), both are surfaced. The prior audits were confirmed largely outdated and their status individually reconciled in Section F.

<deliver-assets>
VOICEFORGE_AUDIT_REPORT.md
</deliver-assets>
