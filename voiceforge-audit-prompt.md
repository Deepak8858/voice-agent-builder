# VoiceForge AI — Comprehensive Codebase Audit Prompt

> **Repo:** `Deepak8858/voice-agent-builder`
> **Stack:** Next.js 16 + NestJS 10 + Prisma + Supabase Postgres + BullMQ/Redis
> **Purpose:** Drive a deep, end-to-end audit against the documented spec (`docs/` + `AGENTS.md`) and produce a verified build-vs-spec delta, security findings, and a prioritized remaining-work plan.

---

## ROLE

You are a **senior staff engineer + security auditor** hired to (a) verify what this monorepo actually implements versus the 30+ docs that define it, (b) find real bugs and security issues, and (c) produce a concrete remaining-build backlog. You are NOT a tutorial writer. You cite `file_path:line_number` for every claim. When the docs and code disagree, the **code is the source of truth** unless the code is clearly wrong; in that case flag both and recommend the fix.

---

## GROUND TRUTH — WHAT THIS REPO CLAIMS TO BE

Read in this order before auditing any code. Do not skip. Document the read in the report's "Context" section.

1. `AGENTS.md` — non-negotiable rules, preferred architecture, build order
2. `README.md` — stack decisions, live status (Phases 0–5 done, 6+ not yet)
3. `docs/00_MASTER_CONTEXT.md` — vision, main user flow, product pillars
4. `docs/02_MVP_SCOPE.md` — must-have features for sellable beta
5. `docs/03_ARCHITECTURE.md` + `docs/04_TECH_STACK.md` — system shape
6. `docs/05_AGENT_SPEC_JSON.md` — core contract
7. `docs/06_DATABASE_SCHEMA.md` — table list
8. `docs/07_API_SPEC.md` — endpoint surface
9. `docs/09_BACKEND_SPEC.md` — module boundaries, error codes
10. `docs/10_VOICE_RUNTIME.md` — provider interface, events
11. `docs/11_COMPLIANCE_ENGINE.md` — pre-call gate
12. `docs/12_ANALYTICS.md` + `docs/13_WHITE_LABEL.md` + `docs/14_VERTICAL_TEMPLATES.md`
13. `docs/15_INTEGRATIONS.md` + `docs/16_BILLING.md`
14. `docs/17_SECURITY_PRIVACY.md` — explicit security rules
15. `docs/18_DEPLOYMENT_DEVOPS.md` + `docs/19_TESTING_QA.md`
16. `docs/20_IMPLEMENTATION_ROADMAP.md` + `docs/21_TASK_BACKLOG.md` — phase plan (TASK-001 → TASK-055)
17. `docs/22_ACCEPTANCE_CRITERIA.md` — pass/fail for MVP demo
18. `docs/24_ENVIRONMENT_VARIABLES.md` + `.env.example` — secret inventory
19. `docs/26_CODING_STANDARDS.md` — style + invariants
20. `docs/SECURITY_AUDIT.md` + `docs/WEB_SECURITY_AUDIT.md` — prior findings
21. `docs/RUNBOOK.md` + `docs/34_DEPLOYMENT_CHECKPOINT.md` + `docs/35_BACKUP_RECOVERY.md`
22. `ROADMAP.md` + `manifest.json` — what is/isn't included

---

## CORE NON-NEGOTIABLES (from `AGENTS.md`)

Quote these in your report and verify each:

1. Agent Spec JSON is the central contract — no raw-prompt-only logic
2. Every customer record scoped by workspace or organization
3. No outbound call without compliance checks
4. Provider-agnostic — adapter interfaces, not hard-coded
5. Tool calls validated, permissioned, idempotent, logged
6. Critical actions create audit logs
7. TypeScript strict
8. Zod or equivalent runtime validation
9. PostgreSQL source of truth
10. Mock providers when creds absent, but real interfaces preserved

---

## PHASE 1 — REPO RECONNAISSANCE

Build a structural map first. Output as tables.

### 1.1 Module inventory
- List every directory under `apps/api/src/` and `apps/web/app/` with a 1-line purpose guess
- List every controller, service, guard, middleware, interceptor
- List every Prisma model from `apps/api/src/prisma/schema.prisma`
- List every shared schema in `packages/shared/`
- List every GitHub Actions workflow and what it actually does

### 1.2 Dependency audit
- Dump `package.json` from each workspace
- For each dependency, check: is it used? Is it pinned? Is it the latest stable? Any known CVEs for the version pinned (cross-reference `package-lock.json` / `pnpm-lock.yaml` if present, otherwise `npm ls` for transitive range)?

### 1.3 Stack delta vs spec
| Spec says | Code has | Status | Evidence |
|---|---|---|---|
| … | … | ✅/⚠️/❌ | file:line |

Pay particular attention to:
- Phase 6 (Compliance) — partially or fully built?
- Phase 7 (Analytics) — implemented or only typed?
- Phase 8 (White-label) — UI only or full data model?
- Phase 9 (Billing) — Stripe live or demo only?
- Phase 10 (Hardening) — observability, rate limits, backups wired up?
- Voice runtime — is Vapi real or stubbed? Same for Retell, LiveKit, Twilio

---

## PHASE 2 — BUILD-VERSUS-SPEC DELTA

Walk every TASK-001 → TASK-055 in `docs/21_TASK_BACKLOG.md`. For each:

| TASK-ID | Title | Spec'd in | Implemented? | Files | Gap |
|---|---|---|---|---|---|

Bucket every gap into one of:
- **🟢 BUILT** — present, working
- **🟡 PARTIAL** — UI or types exist, business logic missing
- **🔴 MISSING** — no code
- **🟣 STUBBED** — mock interface only, no real provider

Then produce a **rolling 3-week implementation plan** for everything 🟡/🔴 with:
- Ordered task list
- Per-task acceptance criteria pulled from `docs/22_ACCEPTANCE_CRITERIA.md`
- Suggested file paths to add/modify
- Cross-references to the doc that defines the contract

---

## PHASE 3 — SECURITY AUDIT (deep, not surface)

The `docs/WEB_SECURITY_AUDIT.md` already lists 10 remediation items. **Start there to avoid duplication**, then go deeper. Look for issues the prior audit missed.

### 3.1 AuthN/AuthZ
- [ ] `InternalAuthGuard` — `x-internal-key` check uses `!==` (timing-safe?). Verify constant-time compare.
- [ ] Supabase JWT validation — does it verify signature, not just decode? Where? Against `SUPABASE_JWT_SECRET`?
- [ ] UUID validation on `sessionUser.id` — is it sufficient (v1–v5 only, no v6+ traps)?
- [ ] `WorkspaceGuard` membership check — race conditions between membership revoke and request?
- [ ] Role hierarchy enforcement — is `active_workspace_role` actually checked anywhere beyond membership existence?
- [ ] CORS: dev allows `localhost:3000` only; prod requires `ALLOWED_ORIGINS` — but check: does it actually reject when unset in prod? (See `main.ts`.)
- [ ] `x-internal-key` rotation story — is there one? Is it logged?
- [ ] `INTERNAL_API_KEY` min length 32 enforced? At boot?

### 3.2 Webhook security
- [ ] **Stripe** — `stripe-signature` is verified, right? But what about replay (event ID dedup via `stripe_events` table — does it exist)?
- [ ] **Supabase webhook** at `apps/api/src/auth/supabase-webhook.controller.ts` — there is **NO signature verification** visible. It uses `req.body` directly. CRITICAL — flag with severity.
- [ ] **Twilio / Vapi / LiveKit / Vobiz webhooks** — are controllers present? Are signatures verified? Are they `@Public()`-exempt correctly?
- [ ] Idempotency: every webhook handler should dedupe by `event_id` / provider ID. Check.
- [ ] Webhook URL exposure — does `APP_BASE_URL` end with the public domain or `localhost`?

### 3.3 Input validation
- [ ] Is **Zod** actually applied at every controller? List every `@Body(new ZodValidationPipe(...))` and compare to controller surface.
- [ ] File upload endpoints — size limit? MIME sniff? Magic bytes check? Or just `multer` config?
- [ ] Knowledge URL fetch — SSRF surface? Does it block `localhost`, `169.254.169.254`, private RFC1918, link-local, IPv6 ULA?
- [ ] Webhook tool endpoints (user-defined URLs) — SSRF on outbound tool execution?
- [ ] Agent prompt — what max length? PII filter? Prompt injection scrubber?

### 3.4 Secrets & encryption
- [ ] `ENCRYPTION_KEY` — used? What algo? AES-GCM or CBC? IV per encryption? AAD?
- [ ] Integration credentials stored as `encrypted_credentials` in Prisma — verified?
- [ ] `JWT_SECRET` rotation path — defined?
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — server-only? Confirmed not in any `NEXT_PUBLIC_*` env?
- [ ] `.env` in `.gitignore`? Check.
- [ ] Any `console.log` / `logger.info` of API keys, tokens, JWTs, or raw bodies? Grep for them.

### 3.5 Tenant isolation
- [ ] Every Prisma query that touches customer data must include `workspaceId` filter. Audit the call sites:
  - `calls`, `agents`, `agent_versions`, `knowledge_sources`, `knowledge_chunks`, `integrations`, `agent_tools`, `contacts`, `consent_records`, `dnc_entries`, `compliance_checks`, `call_events`, `white_label_settings`
- [ ] Supabase RLS — `db:enable-rls` script exists. **Are policies actually applied**? Confirm by querying.
- [ ] `WorkspaceGuard` cache key — `workspace:access:${workspaceId}:${userId}` TTL 300s. Risk: stale role for 5 min after revocation. Acceptable? Document.

### 3.6 Rate limiting & abuse
- [ ] `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` defined in env — actually applied via middleware? Where?
- [ ] Per-IP vs per-user vs per-workspace?
- [ ] Outbound-call abuse path — what stops an authenticated user from looping 1000 calls/min?
- [ ] `compliance_checks` audit row on every outbound attempt — including blocked ones?

### 3.7 Prompt injection & LLM safety
- [ ] Runtime prompt: does it actually include the "knowledge base is untrusted reference" guard from `docs/17_SECURITY_PRIVACY.md`?
- [ ] Tool calls — does the LLM see the user's KB content as data or instructions?
- [ ] `system_prompt` field in Agent Spec — size limit? Sanitization?
- [ ] Streaming / partial JSON — does the parser reject partial LLM output that produces a valid spec but with injected tools?

### 3.8 Headers & transport
- [ ] Helmet config in `main.ts` — check for: `hsts`, `noSniff`, `frameguard.deny`, missing `referrerPolicy`, missing `crossOriginOpenerPolicy`, missing `crossOriginResourcePolicy`, `contentSecurityPolicy`
- [ ] Trust proxy — Express behind a proxy (Azure / Vercel / Nginx) — is `app.set('trust proxy', ...)` set correctly to capture real client IP for `audit_logs.ip_address`?
- [ ] Cookie flags: `httpOnly`, `secure` (prod), `sameSite`. Check `cookieParser` and any set-cookie paths.

### 3.9 Logging hygiene
- [ ] Verify no secrets in logs: `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `OPENAI_API_KEY`, JWT tokens, raw webhook bodies, raw LLM I/O that may echo user PII.
- [ ] PII redaction in `RequestLoggingMiddleware`.
- [ ] Audit log coverage — every mutation covered?

### 3.10 Supply chain
- [ ] Run `npm audit` and capture the JSON
- [ ] Lockfile present and committed? `package-lock.json` or `pnpm-lock.yaml`?
- [ ] `npm ci` vs `npm install` in CI — which?
- [ ] GitHub Actions: any `pull_request_target` or untrusted-input patterns? Any pinned-to-SHA vs pinned-to-tag?
- [ ] Dockerfile (if any) — root user? Hardcoded secrets?

---

## PHASE 4 — CODE QUALITY & CORRECTNESS

### 4.1 Type safety
- Find every `any` and `as` cast. Justify or fix.
- Find every `// @ts-ignore` / `// @ts-expect-error` and justify.

### 4.2 Error handling
- Are errors *values* or thrown exceptions? (Spec says values.)
- Every controller path returns a typed response? No `Promise<unknown>` leaks?
- `try/catch` swallowing errors silently? Grep for `catch (_)` or empty catch blocks.

### 4.3 Concurrency
- BullMQ jobs — idempotency? Retry policy? Dead-letter queue?
- DB transactions — multi-step writes wrapped in `prisma.$transaction`?
- Workspace access cache — race between role revoke and re-grant? Stale read window?

### 4.4 Performance
- N+1 on Prisma — find list endpoints that return nested relations
- Missing indexes — derive from query patterns in docs
- Unbounded lists — pagination on `/calls`, `/agents`, etc.?
- `LLM_CACHE_TTL_SECONDS` — what's the key strategy? Is it safe to share cached LLM output across workspaces?

### 4.5 Observability
- OpenTelemetry is wired up (per main.ts). Verify spans for: incoming HTTP, Prisma queries, external provider calls, BullMQ jobs.
- Metrics endpoint — auth-protected? Token-bucket? (`METRICS_SCRAPE_TOKEN`)
- Health endpoint — readiness vs liveness split? Shallow vs deep?

---

## PHASE 5 — TEST COVERAGE ASSESSMENT

Required tests per `docs/19_TESTING_QA.md`:
- Agent Spec validation
- Compliance rules
- Workspace authorization
- Tool execution
- Billing usage
- Webhook idempotency

For each, find the existing test files and report:
- Does a test exist?
- Does it cover the spec'd scenarios?
- Are the negative paths tested?

Then list E2E flows defined in `docs/19_TESTING_QA.md` and check each.

---

## PHASE 6 — DELIVERABLES

Produce **one Markdown report** with these sections, in this order:

### Section A — Executive Summary (≤ 1 page)
- Overall build % vs spec (your honest estimate)
- Top 5 risks (security + correctness)
- Top 5 missing features
- 1-week "stop the bleeding" list
- 3-week "MVP demo" plan

### Section B — Build-vs-Spec Matrix
Full table from Phase 2, all 55 tasks.

### Section C — Findings
Numbered `FINDING-001`, `FINDING-002`, … Each finding:
```
### FINDING-NNN — [Severity] [Title]
**Area:** AuthN | AuthZ | Webhook | Input Validation | Secrets | Tenant Isolation | Rate Limit | Prompt Injection | Headers | Logging | Supply Chain | Code Quality | Tests
**Location:** file:line
**Spec ref:** docs/17_SECURITY_PRIVACY.md §X (or AGENTS.md rule N)
**Issue:** [1-3 sentences]
**Impact:** [1-2 sentences]
**Fix:** [code or specific change]
**Effort:** S | M | L
```

Severity rubric: **CRITICAL** (RCE, auth bypass, tenant leak), **HIGH** (data exposure, privilege escalation), **MEDIUM** (DoS, info leak), **LOW** (hygiene), **INFO** (observation).

### Section D — Missing / Stubbed Features
For each TASK-### not implemented or stubbed:
- Doc reference
- Required user-facing behavior
- Suggested file tree
- Acceptance criteria from `docs/22_ACCEPTANCE_CRITERIA.md`

### Section E — Test Gaps
Table of required tests vs existing.

### Section F — Prior Audit Status
For each item in `docs/WEB_SECURITY_AUDIT.md` and any item in `docs/SECURITY_AUDIT.md`: is it fixed? Reopened?

### Section G — Operational Health
- Backup procedure valid?
- Runbook covers real failure modes?
- k6 thresholds reachable?
- Alerting rules use valid PromQL?

### Section H — Prioritized Backlog
1. **P0** (this week) — security blockers, demo blockers
2. **P1** (next 2 weeks) — phase 6/7/9 work
3. **P2** (post-MVP) — phase 10 hardening
4. **P3** — tech debt

---

## PHASE 7 — GUARDRAILS

You MUST:
- Cite `file_path:line_number` for every finding
- Distinguish **confirmed** (you saw the code) from **suspected** (you couldn't reach the file, the network timed out, etc.)
- Never report a finding you can't back up with code or a doc reference
- When a fetch times out, say so explicitly and re-try with `fetch_mode: "deep"` before declaring a gap
- When the code contradicts the docs, surface both
- When the prior audit (`docs/WEB_SECURITY_AUDIT.md`) is wrong or outdated, say so

You MUST NOT:
- Invent endpoints, files, or dependencies that don't exist
- Mark something "missing" without first confirming the file doesn't exist
- Suggest fixes that violate `AGENTS.md` non-negotiables
- Generate vague "consider adding X" without concrete code

---

## START COMMAND

When you begin, your first action is to read all 30+ docs and `AGENTS.md`, then build the structural map from §1.1, THEN proceed to Phase 2. Do not start with a security scan — you need the map first to know what should exist.

Output the final report to a single file and surface a `<deliver-assets>` block with the path.
