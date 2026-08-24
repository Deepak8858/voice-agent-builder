# VoiceForge AI — Roadmap

**Score: 8/10** · Reconciled against `feat/google-tools-vapi-calls` at commit `a6a89f2`.

The previous version of this document scored the product 5/10 and described a
codebase with broken HMAC webhooks, in-memory provider-id caches, a non-existent
flow builder, a broken free tier, no pricing page, and 139 tests. Every one of
those claims is now false. This rewrite re-verified each item against code rather
than carrying the narrative forward.

## Where the score comes from

The product is feature-complete against its own MVP spec and the security posture
is good. Points are withheld for process and operations, not for features.

**What earns the score.** All nine build phases are implemented and tested: agent
generation and versioning, templates, knowledge ingestion and retrieval, two
production voice runtimes, calls and transcripts, compliance and consent gating,
analytics, white-label, and billing. As of commit `a6a89f2`, 1,536 tests pass
across the monorepo. Typecheck, lint, and build were also green at that commit. The
major security findings from the last audit are closed — centralized SSRF
protection, nonce-based CSP, bounded proxy trust, constant-time secret comparison,
JWT audience and issuer pinning, and raw-byte webhook signature verification. The
production deploy path is now commit-pinned with rollback.

**What holds it back.**

1. **Required-check enforcement is not configured.** Automatic CI now runs on
   every pull request and push to `main`, but `main` has no branch protection, so
   the quality gate can still be bypassed during merge.
2. **The AWS deploy path still needs an operational exercise.** The dispatch-only
   workflow maps an exact commit to immutable ECR images and includes rollback, but
   the repository cannot prove that a production deploy and rollback drill have run.
3. **Sensitive scratch paths are untracked, but history/rotation status is unknown.**
   `supabase/.temp/` and `.claude/worktrees/` are ignored and have zero tracked
   paths. Repository state does not prove that prior history was purged or that any
   potentially exposed credentials were rotated.
4. **Coverage holes in exactly the wrong places — closed.** The cross-tenant
   authorization sweep now exists (item 4), route-level tenant authorization is
   ratcheted separately (item 4b), and `apps/voice-edge` was deleted rather than
   tested (item 5).

Reaching 10/10 is mostly an operations exercise at this point, not a feature one.

## Verified state of previously-claimed gaps

Each item below was listed as broken or missing in the prior roadmap and has been
re-checked.

**Webhook HMAC — fixed.** Signature verification runs over exact raw bytes with a
timestamp binding, not re-serialized JSON
(`apps/api/src/calls/voice-webhook.controller.ts:36,47-48`). `rawBody: true` is set
at bootstrap (`apps/api/src/main.ts:32`). `VOICE_WEBHOOK_SECRET` is required
non-empty in production (`apps/api/src/config/env.ts:135-141`).

**Provider runtime id persistence — fixed.** `providerRuntimeId` is a schema field
on `AgentVersion` (`apps/api/prisma/schema.prisma`), not an in-memory map.

**`JWT_SECRET` fail-fast — fixed.** Minimum 32 characters, and the development
default is refused in production (`apps/api/src/config/env.ts:97-100`).

**Free tier — fixed.** The free plan grants 10 minutes per month, 1 agent, 1
concurrent call, and 50 contacts (`packages/shared/src/billing/catalog.ts`). The
allowance recurs monthly, is granted by `free-credit-grant.worker.ts`, and is
spendable only on the in-house `standard` pipeline. Free has no PSTN
entitlement, so browser tests are the only thing that can spend it — which is
exactly why the former one-time 180-second browser test was retired.

**Visual flow builder — exists.** `apps/web/components/flow-builder/` contains the
client, model, node palette, config panel, and typed node components, with model
tests at `flow-builder-model.test.ts`.

**Pricing page — exists.** `apps/web/app/pricing/page.tsx`.

**Public agent share pages — exist.** `apps/web/app/a/[slug]/page.tsx`.

**Referral system — exists.** `apps/api/src/referral/` with controller, service, and
module, plus schema backing.

**Own voice pipeline — superseded and deleted.** `apps/voice-edge/` was a Twilio
Media Streams bridge over Deepgram + Cartesia. It was never deployed (no compose
service, no workflow reference, present only in the root `typecheck` script) and
was made redundant by the in-house `standard` pipeline in `apps/livekit-agent`.
Its μ-law codec was also irreparably wrong — see item 5 — so it was removed
instead of tested.

**Vapi and Retell adapters — removed.** Both adapters, their tests, and the Vapi
tools controller were deleted, along with every `VAPI_*`/`RETELL_*` variable. The
supported runtimes are OpenAI Realtime and the in-house `standard` pipeline
(`apps/livekit-agent/src/standard-pipeline.ts`), selected per call by
`PipelineRouterService`. A retired `VOICE_PROVIDER` value is coerced to
`openai-realtime` with a deprecation warning so an upgrade cannot fail at boot;
see `docs/RUNBOOK.md` §2 for the env migration.

**Test count — was 139, is now 1,536.** Commit `a6a89f2` records 1,536 passing
tests, with typecheck, lint, and build green. This count is cited from that commit's
gate result rather than rerun solely for this documentation reconciliation.

## Implemented versus configured

Feature completeness in code does not mean the capability is live. These three are
worth stating plainly.

**LiveKit / BYO telephony.** Implemented and tested. All LiveKit env vars are
optional (`apps/api/src/config/env.ts:52-59`); the AWS deploy runs the `livekit`
Compose profile only when all three credentials are present and aborts on a partial
set (`.github/workflows/deploy-aws-ec2.yml:476-485`). Production configuration is
unverifiable from this repository.

**Email.** Fully implemented, including a tenant-scoped weekly digest restricted to
owners and admins (`apps/api/src/email/email.service.ts:164-242`). It degrades
cleanly to `{ status: 'skipped', reason: 'email_not_configured' }` without
`RESEND_API_KEY` (lines 165-170). It is now scheduled: `workers/digest.worker.ts`
registers a repeatable BullMQ job on `WEEKLY_DIGEST_CRON` that fans out one job
per active workspace, so a single tenant's failure cannot abort the run. It only
runs where `WORKERS_ENABLED=true`.

**Billing.** Implemented; `BILLING_MODE` defaults to `demo`
(`apps/api/src/config/env.ts:111`) and the web client disables checkout in any
non-`live` mode (`apps/web/lib/billing-mode.ts:22-30`). The AWS deploy requires
`BILLING_MODE=live` and non-empty Stripe variables in `/opt/voiceforge/.env`
(`.github/workflows/deploy-aws-ec2.yml:429-451`), so a successful deploy implies
live billing.

## Open work, prioritized

### P0 — process and secrets

**1. Automatic CI — implemented; required-check enforcement remains open.**
`.github/workflows/quality-gate.yml` runs on every pull request and push to `main`.
It installs with the frozen lockfile, scans secrets, audits production dependencies,
generates Prisma, builds shared, typechecks, lints, tests, builds API/web, verifies
container dependency integrity, and rejects tracked credential scratch paths. The
production deploy remains dispatch-only. `main` still has no branch protection, so
configure the Quality Gate jobs as required status checks before treating this as an
enforced merge gate.

**2. Scratch paths untracked and ignored — index cleanup done; history and rotation
remain open.** `git ls-files supabase/.temp .claude/worktrees` returns no paths, and
`.gitignore` excludes both directories. Commits `b9a6266` and `cd8da3a` performed
the respective index cleanups. The current tree cannot verify that old commits were
purged or that credentials which may have transited those paths were rotated; audit
history and rotate affected credentials if that separate operational work has not
already occurred.

**3. Exercise the AWS production deploy and rollback.** Dispatch
`.github/workflows/deploy-aws-ec2.yml` with a full commit SHA and the explicit
production confirmation. Verify the Depot builds, immutable ECR tags, EC2 rollout,
health gates, recorded release state, and rollback path before an incident requires
them.

### P1 — close the coverage holes that matter

**4. Cross-tenant authorization test sweep — done.** Two complementary mechanisms
live in `apps/api/src/security/`. `cross-tenant-isolation.test.ts` runs the real
services against an in-memory Prisma stand-in that actually *evaluates* `where`
clauses over a seeded two-workspace dataset, so dropping a `workspaceId` predicate
genuinely returns the foreign row and fails the test. `tenant-scope-baseline.test.ts`
is a static ratchet: it re-derives the tenant-scoped models from `schema.prisma`
and fails on any *new* unscoped query, keyed by `file:model.operation` so unrelated
edits do not churn. The sweep found five real cross-tenant defects, all fixed:
unscoped phone-number assign/release, an unscoped contact re-read that let another
tenant's opt-out state drive a compliance decision, an unscoped consent lookup, a
foreign call transcript feeding CRM routing, and an unscoped agent publish.

**4b. Route-level authorization gaps — done.** The two gaps left open above are
closed, and reviewing them surfaced three more of the same class. The service-layer
sweep could not see any of these: a query scoped by `where: { workspaceId }` is
still a cross-tenant hole when `workspaceId` is a path param nobody verified.

- `phone-numbers`, `audit`, and `crm-routing` controllers, all routed under
  `/workspaces/:workspaceId/`, now carry `WorkspaceGuard`. Previously the URL's
  `workspaceId` was attacker-chosen and the service predicate was worthless.
- `orchestrator.controller.ts` no longer derives the workspace as
  `req.workspace?.id ?? req.user?.workspaceId ?? req.user?.id ?? ''`. Nothing ever
  assigns `req.workspace` and `SessionUser` has no `workspaceId`, so it collapsed to
  the caller's *user id*, then to `''`. It now reads `active_workspace_id` and fails
  closed.
- **`WorkspaceGuard` silently no-opped on any route without a `:workspaceId`
  param**, which was the root cause of the rest. It returned `true` early, so
  applying it to a route keyed by a differently-named param produced a route that
  looked guarded in review while checking nothing. It now throws instead; routes
  that legitimately take their tenant from the session declare `@SessionScoped()`.
- `DELETE v1/orgs/:orgId/contacts/:contactId/erasure` was the worst instance: it
  carried the no-opping guard, and `ErasureService.eraseContact` treats its first
  argument as a `workspaceId`, so **any authenticated user could permanently delete
  another tenant's contact** along with its cascaded calls, consent records,
  compliance checks, analytics events, evaluations and tool invocations. The route
  is now `v1/workspaces/me/contacts/:contactId/erasure` and takes the tenant from
  the verified session.
- `GET v1/orgs/:orgId/audit-logs` had **no guard at all** — only its sibling
  `admin/*` routes did — so any authenticated user could read any organization's
  audit log. It now uses the new `OrganizationGuard`, which verifies membership in a
  workspace belonging to `:orgId` (or ownership of the org itself), since membership
  is modelled per workspace rather than per org.
- `PATCH v1/workspaces/me/retention` and three `referrals` routes carried the
  decorative guard. They were safe in effect but derived the tenant as
  `active_workspace_id ?? user.id`, falling back to a user id as a workspace id.
  They now fail closed and are marked `@SessionScoped()`.

`security/route-guard-analyzer.ts` plus `route-guard-baseline.test.ts` make this a
ratchet at the layer the tenant-scope analyzer cannot see. It walks every
controller and reports any route whose path names a tenant that its guards cannot
check — `WorkspaceGuard` counts only for `:workspaceId`, `OrganizationGuard` only
for `:orgId`. Unlike the tenant-scope baseline this one is empty and must stay
empty: accepting a tenant id from the URL without authorizing it is never correct.
All 116 tenant-param routes are covered. Each fix was mutation-tested by reverting
it and confirming a specific test fails.

**5. `apps/voice-edge` — deleted rather than tested.** Testing it would have
entrenched a second, undeployed voice runtime that duplicates the in-house pipeline
via providers (Deepgram, Cartesia) used nowhere else. Its μ-law codec was not
merely imprecise but non-functional: all 65536 encode values differed from ITU-T
G.711, the decode table spanned ±512 instead of ±32124, round-tripping failed for
all 256 codes, and on a 440 Hz tone the error RMS exceeded the signal RMS — the
output was noise, not degraded audio. Silence encoded to `0x71` instead of `0xFF`.
A correct implementation already exists in the LiveKit pipeline path.

**6. Include `apps/web` in the root `test` script — done.** The root `test` script
now runs shared, api, livekit-agent, and web, so a local green matches CI.

**7. Schedule the weekly digest, or remove it — done.** `workers/digest.worker.ts`
registers a repeatable job keyed on `WEEKLY_DIGEST_CRON` and fans out per workspace.

### P2 — toolchain and hygiene

**8. Pin the package manager — done.** Root `package.json` declares
`"packageManager": "pnpm@10.33.2"`, matching
`.github/workflows/quality-gate.yml:29`.

**9. Declare `express` in `apps/api/package.json`.** It is used transitively via
`@nestjs/platform-express` hoisting. `main.ts` no longer imports it directly
(`apps/api/src/main.ts:3,31,78-80`), so this is latent — but it depends on a hoisting
layout that is not guaranteed.

**10. Convert knowledge search from GET to POST — done.**
`apps/api/src/knowledge/knowledge.controller.ts:99-109` exposes
`POST /workspaces/:workspaceId/knowledge-sources/search` and validates the request
body, so query terms no longer appear in the URL.

**11. Superseded audit docs — done in this pass.** `docs/SECURITY_AUDIT.md` and
`docs/WEB_SECURITY_AUDIT.md` described a Clerk-era codebase and have been reduced to
pointers at `VOICEFORGE_AUDIT_REPORT.md`.

**12. Fix stale landing-page copy — done.** The landing page now describes the
OpenAI Realtime and in-house Azure pipelines instead of a mock runtime and
"Retell-ready", and the privacy policy lists Microsoft Azure, OpenAI, and
LiveKit as subprocessors in place of Vapi.

### P3 — consolidation

**13. Consolidate deployment on AWS — done.** The Azure VM, GCP, and legacy EC2
workflows and the old production Compose definition were deleted during the AWS
migration. The sole production path is the dispatch-only
`.github/workflows/deploy-aws-ec2.yml`, which builds with Depot, stores immutable
images in ECR, and deploys `infra/docker/docker-compose.aws.yml` to EC2. Remaining
cloud-specific values and provisioning assumptions are documented under `infra/aws/`.

**14. Runtime-verify the operational assets — static/local verification done; live
restore drill remains open.** The backup preflight now fails closed on missing
inputs and accurately states that it checks only a recent non-empty local artifact,
recovery-env keys, and live-database connectivity. The AWS runbook and backup guide
now match the dispatch-only EC2/Depot/ECR deploy, external Supabase Postgres, and S3
knowledge-storage split. All tracked k6 JS/TS files parse under Node 24; current
`k6/` routes, health response assertions, and Supabase-token prerequisites were
reconciled with the API. The legacy `load-tests/k6/` collection still targets
removed unscoped auth/agent/knowledge/webhook routes and needs a separate redesign
rather than mechanical URL substitution. k6 was not installed locally, so no live
load was generated. A credentialed restore into an isolated database, integrity
checks, S3 object recovery check, and measured RTO/RPO are still required before
the backup story is operationally proven.

## What would make this 10/10

In order: enforce the automatic CI jobs through branch protection; exercise one
traceable AWS production deploy and rollback; verify sensitive-path history purge
and credential rotation; and complete a backup restore drill. The automatic quality
gate, current-tree scratch-path cleanup, cross-tenant sweep, route-guard ratchet,
and `apps/voice-edge` decision are done. None of the remainder is feature work. The
product is built — what is missing is the operational proof that it stays built.
