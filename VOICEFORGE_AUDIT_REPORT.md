# VoiceForge AI — Security Audit Report

**Scope:** `integration/prod-readiness` at commit `a3deeb3`.
**Stack:** Next.js 16 + React 19 (`apps/web`) · NestJS 10 + Prisma (`apps/api`) ·
Supabase Postgres · BullMQ/Redis · Vapi / Retell / OpenAI Realtime / LiveKit ·
`packages/shared` (Zod).
**Method:** static analysis and taint tracking, doc-vs-code delta, config/IaC/CI
review, dependency manifest review. Runtime exploitation was not performed.
Findings are **Confirmed** (code read this pass) unless marked **Unverified**.

> **Prior audit documents are superseded.** `docs/SECURITY_AUDIT.md` and
> `docs/WEB_SECURITY_AUDIT.md` are dated 2026-05-01 and describe a Clerk +
> mock-auth codebase that no longer exists. Do not use them. Their items are
> reconciled in Section D of this report; this report supersedes both.

## Section A — Executive summary

The original round of this audit found two Critical and a set of High/Medium
issues. **Most have since been remediated.** This revision re-verified every
finding against current code rather than restating the earlier conclusions.

Remediated since the first pass: centralized SSRF protection, the OAuth open
redirect, the dead unauthenticated webhook controller, weak verification-token
RNG, permissive CSP, unset `trust proxy`, timing-unsafe secret comparisons, and
missing JWT audience/issuer validation. The committed browser profiles are no
longer tracked in the working tree.

What remains open is concentrated in two places, and neither is an application
code defect:

1. **`supabase/.temp/` is still tracked in git**, and a stale nested agent
   worktree under `.claude/worktrees/` carries a second copy of it. This is a
   real, currently-open finding.
2. **No automatic CI.** The quality gate exists but never fires, because all
   workflows are `workflow_dispatch`-only. Every control in that gate — secret
   scanning, dependency audit, typecheck, lint, test — is therefore advisory.

The application security posture is otherwise sound: a global auth guard,
consistently workspace-scoped queries, HMAC-verified and replay-windowed provider
webhooks, AES-256-GCM encryption at rest, audit logging on mutations, Zod
validation at controllers, and a nonce-based CSP.

## Section B — Open findings

### FINDING-006 — [MEDIUM] Supabase project ref and pooler DSN committed — **OPEN**
**Area:** Secrets · **Location:** `supabase/.temp/` (9 tracked files, including
`pooler-url`, `project-ref`, `linked-project.json`)
**Issue:** The production project ref, org id, region, and pooled DB DSN are
committed. No password is included, but this is a precise target map for the
database endpoint.
**Verification:** `git ls-files supabase/.temp` returns 9 paths at `a3deeb3`.
**Fix:** `git rm -r --cached supabase/.temp`, add it to `.gitignore`, and purge it
from history. Confirm no `service_role` key ever transited these files; rotate the
database password if uncertain. **Effort:** S

### FINDING-024 — [MEDIUM] Stale agent worktrees committed under `.claude/` — **OPEN**
**Area:** Secrets / repo hygiene · **Location:** `.claude/worktrees/` (67 tracked
paths across two snapshots, `awesome-euclid-91545b` and `exciting-allen-606b3c`)
**Issue:** Two abandoned agent worktree snapshots are committed into the
repository. They contain a duplicate of `supabase/.temp/` — including
`pooler-url`, `project-ref`, and `linked-project.json` — plus deployment scripts
(`vm-bootstrap.sh`, `vm-deploy.sh`, `generate-prod-env.js`), old Supabase
migrations, a `status.md`, and a full chat transcript
(`voice_calling_agent_builder_full_chat.md`).
**Verification:** scanned every tracked file under `.claude/` for credential-shaped
content (`service_role`, JWT-shaped strings, Stripe key prefixes, inline passwords,
DSNs with embedded credentials). **No credential values were found**, so this is
exposure of infrastructure metadata and operational tooling, not live secrets.
This is why the severity is MEDIUM rather than CRITICAL.
**Impact:** Duplicates the FINDING-006 target map in a second location that a
cleanup of `supabase/.temp/` alone would miss. The transcript and deploy scripts
also widen the recon surface.
**Fix:** `git rm -r --cached .claude/worktrees`, add `.claude/worktrees/` to
`.gitignore`, and purge from history alongside FINDING-006 in the same pass.
**Effort:** S

### FINDING-021 — [MEDIUM] Quality gate never runs automatically — **OPEN**
**Area:** Supply chain / process · **Location:**
`.github/workflows/ci-cd-ec2.yml:13-14`, `deploy-gcp.yml:5-6`,
`deploy-azure-vm.yml:5-12`
**Issue:** All three workflows are `workflow_dispatch`-only. The
`lint-typecheck-test` job (`ci-cd-ec2.yml:34-76`) contains gitleaks secret
scanning, `pnpm audit --prod --audit-level=high`, typecheck, lint, and test — but
never executes on a push or pull request. Nothing mechanically blocks a
regression, a leaked secret, or a vulnerable dependency from being merged.
**Impact:** Every other control in this report can silently regress.
**Fix:** Add a dedicated CI workflow triggered on `pull_request` and on pushes to
protected branches, containing the existing gate job, and mark it a required
status check. Keep deploy workflows dispatch-only. **Effort:** S

### FINDING-019 — [INFO] Hardcoded AWS account ids in legacy compose — **OPEN**
**Area:** Config · **Location:** `infra/docker/docker-compose.prod.yml`
**Issue:** Account-id disclosure in the legacy AWS path. Low impact, and the AWS
path is being decommissioned, but it should be externalized or removed with the
rest of the EC2 tooling. **Effort:** S

### FINDING-016 — [LOW] `reindex` ownership check — **PARTIALLY ADDRESSED**
**Area:** AuthZ (IDOR) · **Location:**
`apps/api/src/knowledge/knowledge.controller.ts:154-162`
**Issue:** The handler now calls `this.knowledge.get(workspaceId, sourceId)` before
enqueuing, which resolves the source within the workspace scope and therefore
rejects a foreign `sourceId`. The residual item is confirming the embeddings
worker itself scopes by workspace, which was not traced this pass.
**Status:** Confirmed at the controller; worker scoping **Unverified**.
**Effort:** S

### FINDING-022 — [LOW] Undeclared `express` dependency — **OPEN, LATENT**
**Area:** Supply chain · **Location:** `apps/api/package.json:24,62`
**Issue:** `express` is not a declared dependency of `apps/api`; only
`@nestjs/platform-express` and `@types/express` are. It resolves through pnpm's
hoisting layout. `main.ts` no longer imports it directly
(`apps/api/src/main.ts:3,31,78-80`), so nothing currently breaks, but the runtime
depends on an undeclared transitive package.
**Fix:** Declare `express` explicitly at the version `@nestjs/platform-express`
expects. **Effort:** S

### FINDING-023 — [LOW] pnpm version not pinned in-repo — **OPEN**
**Area:** Supply chain · **Location:** root `package.json` (no `packageManager`
field); version pinned only at `.github/workflows/ci-cd-ec2.yml:27`
**Issue:** Local installs can use a different pnpm than CI, which is how the
lockfile/overrides mismatch described in `status.md` became possible.
**Fix:** Add `"packageManager": "pnpm@10.33.2"` and rely on corepack.
**Effort:** S

## Section C — Remediated findings

Each item below was re-verified against current code. These are recorded so the
history is auditable, not to imply outstanding work.

**FINDING-001 — [CRITICAL] Committed browser profiles — REMEDIATED IN TREE.**
`git ls-files .codex-browser-shots` returns nothing at `a3deeb3`. History purge and
credential rotation cannot be confirmed from the worktree and remain the operator's
responsibility (**Unverified**).

**FINDING-002 / FINDING-003 — [CRITICAL/HIGH] SSRF in webhook and CRM executors —
FIXED.** A centralized `safeFetch` now exists at `apps/api/src/common/safe-fetch.ts`.
It requires HTTPS (line 55), rejects embedded credentials (line 58), resolves DNS
and validates every returned address (lines 64-73), pins the validated address via a
custom `lookup` to defeat rebinding (lines 100-106), refuses redirects (lines
123-125), and caps responses at 1 MiB (lines 115-118). The blocklist covers IPv4
private, loopback, link-local, CGNAT, and multicast ranges plus IPv6 `::`, `::1`,
`fc00::/7`, `fe80::/10`, and `ff00::/8` (lines 9-25), and handles IPv4-mapped IPv6
(lines 161-168). All tenant-influenced egress routes through it:
`webhook-executor.ts:4,40`, `crm-executor.ts:2,170`,
`tools/executors/google-calendar.executor.ts:2,11,30,48,59`,
`calendar.service.ts:4,109`, and `voice/adapters/retell.adapter.ts:5,276`. Covered
by `apps/api/src/common/safe-fetch.test.ts`.

**FINDING-004 — [MEDIUM] OAuth open redirect — FIXED.** The callback now routes the
`next` parameter through `safeRedirectPath`
(`apps/web/app/auth/callback/route.ts:4,9`), tested in
`apps/web/lib/safe-redirect.test.ts`.

**FINDING-005 — [MEDIUM] Dead unauthenticated webhook controller — FIXED.**
`supabase-webhook.controller.ts` no longer exists under `apps/api/src/auth/`.

**FINDING-007 — [MEDIUM] Public Prometheus — FIXED.** No `prometheus` location
remains in `infra/nginx/`. The metrics endpoint is bearer-token gated
(`apps/api/src/common/metrics.controller.ts:20-24`).

**FINDING-008 — [MEDIUM] Weak RNG for verification token — FIXED.**
`apps/api/src/telephony/telephony.service.ts:3,1214` now uses
`randomBytes(32).toString('base64url')`.

**FINDING-009 — [MEDIUM] Permissive CSP — FIXED.** The policy is nonce-based with
`strict-dynamic` and `script-src-attr 'none'`
(`apps/web/lib/content-security-policy.ts:8-9`), asserted by
`apps/web/lib/content-security-policy.test.ts` and `apps/web/next.config.test.ts:51-52`.
`'unsafe-eval'` is retained for Monaco.

**FINDING-010 / FINDING-012 — [MEDIUM] CI static AWS keys and unpinned SSH host
keys — SUPERSEDED.** These applied to the legacy EC2 path, now dispatch-only. The
Azure deploy requires a pinned `known_hosts` and uses
`StrictHostKeyChecking=yes` (`.github/workflows/deploy-azure-vm.yml:68,83-84,99`).

**FINDING-011 — [MEDIUM] `trust proxy` unset — FIXED.** `TRUST_PROXY_HOPS` is a
bounded integer 0-5 defaulting to 1 (`apps/api/src/config/env.ts:23`) and is applied
via `expressApp.set('trust proxy', env.TRUST_PROXY_HOPS)`
(`apps/api/src/main.ts:33-34`).

**FINDING-013 — [LOW] Timing-unsafe comparisons — FIXED.** Both call sites use
`constantTimeEqual` from `apps/api/src/common/secure-compare.ts`
(`internal-auth.guard.ts:8,47`, `metrics.controller.ts:6,24`).

**FINDING-014 — [LOW] Voice webhook replay — FIXED.** The controller verifies over
exact raw bytes with a timestamp binding rather than re-serialized JSON
(`apps/api/src/calls/voice-webhook.controller.ts:36,47-48`).

**FINDING-015 — [LOW] Error text leaked into SSE stream — FIXED.** The detailed
error is now sent to the server-side logger only
(`apps/api/src/agents/agents.controller.ts:117-120`), while the client receives a
fixed generic string, `'Agent generation failed. Please retry.'` (line 121). No
internal error text reaches the stream.

**FINDING-017 — [LOW] JWT audience/issuer unvalidated — FIXED.** Verification now
pins `audience: 'authenticated'` and the Supabase issuer
(`apps/api/src/auth/supabase-auth.service.ts:121-123`).

**FINDING-020 — [INFO] AGENTS.md rule 10 contradiction — FIXED.** The policy is now
stated accurately in both places: mock providers are permitted for credential-less
development and tests, and rejected at boot in production
(`apps/api/src/config/env.ts:16-17,142-148`; `AGENTS.md` rule 10). The earlier claim
that mocks were removed outright was wrong.

**Build-vs-spec gaps — CLOSED.** The Retell adapter now exists
(`apps/api/src/voice/adapters/retell.adapter.ts`, tested in `retell.adapter.test.ts`)
and is registered alongside Vapi, OpenAI Realtime, and the mock in
`apps/api/src/voice/voice-provider.registry.ts`. Production requires
non-empty `ALLOWED_ORIGINS` and `VOICE_WEBHOOK_SECRET`
(`apps/api/src/config/env.ts:128-141`), closing the prior CORS dead-assertion item.

## Section D — Prior audit reconciliation

`docs/SECURITY_AUDIT.md` and `docs/WEB_SECURITY_AUDIT.md` are **obsolete and should
be deleted or replaced with a pointer to this report.** They describe the Clerk and
mock-auth era. Every item they raise is either fixed, obsolete by migration, or
carried forward into Section B above:

- Metrics public, voice webhook unauthenticated, billing workspace param, billing
  raw body, agent flow unvalidated, upload MIME/filename trust, rate-limit guard not
  applied, `SkipRateLimit` broken, error leakage, Stripe URL open redirect,
  white-label URL/domain validation, invite IDOR — **all fixed**, re-verified in
  Section C or in the current code.
- Mock auth unsigned cookies and auth brute-force — **obsolete**; mock auth was
  removed with the Supabase migration.
- CSP permissiveness — **fixed** (nonce-based, Section C).
- Knowledge search still uses GET, so query terms can land in access logs — **open,
  LOW**. Convert to POST.

## Section E — Test coverage

Measured on this branch: `apps/api` 64 files / 437 tests, `packages/shared` 6 / 18,
`apps/livekit-agent` 1 / 3, `apps/web` 12 files / 65 tests. Typecheck is clean across
all six workspaces and API lint exits 0.

Security-relevant suites confirmed present: `common/safe-fetch.test.ts`,
`common/secure-compare.test.ts`, `common/workspace.guard.test.ts`,
`common/rate-limit.guard.test.ts`, `auth/internal-auth.guard.test.ts`,
`lib/safe-redirect.test.ts`, `lib/content-security-policy.test.ts`,
`middleware-utils.test.ts`, and `next.config.test.ts`.

Remaining gaps:

- `apps/voice-edge` has **no tests at all** and is excluded from the root `test`
  script. It handles live audio and Twilio Media Streams.
- `apps/web` tests are not in the root `test` script, so they are skipped by the
  local gate (they do run under CI's `pnpm -r --if-present run test`).
- A systematic cross-tenant authorization test — asserting every workspace-scoped
  query filters by `workspaceId` — is still absent. Given that tenant isolation is
  enforced at the application layer, this is the highest-value test to add.

## Section F — Architecture and operational risks

1. **Tenant isolation is application-layer.** Authorization is consistently
   `WorkspaceGuard` plus `where: { …, workspaceId }`, with Postgres RLS as
   defense-in-depth. Because the API connects with privileged credentials, a single
   missing `where` clause is a cross-tenant leak. Add the automated coverage noted
   in Section E and keep RLS enabled.
2. **Egress is now centrally controlled** via `safeFetch`. Preserve that property:
   any new outbound call on a tenant-influenced URL must use it. This is worth a lint
   rule or a review checklist item.
3. **Deploy target trifurcation.** AWS EC2, GCP, and Azure workflows all still exist.
   Azure is the sole production target; the other two are dispatch-gated but remain
   live surface area. Delete them once decommissioning completes.
4. **Production traceability.** The running Azure deployment was hand-built and is
   not tied to a commit. `deploy-azure-vm.yml` fixes this going forward but has not
   yet been exercised.
5. **Unverified operational assets.** `scripts/backup-validation.js`,
   `docs/RUNBOOK.md`, `docs/35_BACKUP_RECOVERY.md`, and the k6 suites are present but
   were **not runtime-verified** this pass.

## Section G — Prioritized remediation

**P0**
1. Untrack and purge `supabase/.temp/`; rotate anything it describes (FINDING-006).
2. Add push/PR-triggered CI running the existing quality gate; make it a required
   check (FINDING-021).

**P1**
3. Add a cross-tenant authorization test sweep (Section E).
4. Add tests for `apps/voice-edge`, and include `apps/web` in the root `test` script.
5. Declare `express` explicitly and add `packageManager` to the root `package.json`
   (FINDING-022, FINDING-023).

**P2**
6. Confirm embeddings-worker workspace scoping (FINDING-016); convert knowledge
   search from GET to POST.
7. Done in this pass: `docs/SECURITY_AUDIT.md` and `docs/WEB_SECURITY_AUDIT.md` have
   been reduced to pointers at this report.
8. Remove the GCP and EC2 workflows once Azure decommissioning of those paths is
   complete; externalize the account ids in the legacy compose file (FINDING-019).

## Guardrails

Every finding cites `path:line`. **Confirmed** means the code was read at commit
`a3deeb3`. **Unverified** is used where a claim could not be checked from the
repository — specifically git history purging, credential rotation, production
environment configuration, embeddings-worker scoping, and the runtime validity of
backup, runbook, and k6 assets. No endpoints or files were invented. Where code
contradicted an earlier document, the code was treated as authoritative and the
document corrected.
