# VoiceForge AI — Roadmap

**Score: 8/10** · Reconciled against `integration/prod-readiness` at commit `a3deeb3`.

The previous version of this document scored the product 5/10 and described a
codebase with broken HMAC webhooks, in-memory provider-id caches, a non-existent
flow builder, a broken free tier, no pricing page, and 139 tests. Every one of
those claims is now false. This rewrite re-verified each item against code rather
than carrying the narrative forward.

## Where the score comes from

The product is feature-complete against its own MVP spec and the security posture
is good. Points are withheld for process and operations, not for features.

**What earns the score.** All nine build phases are implemented and tested: agent
generation and versioning, templates, knowledge ingestion and retrieval, four real
voice provider adapters, calls and transcripts, compliance and consent gating,
analytics, white-label, and billing. 523 tests pass across api, shared, and
livekit-agent, plus 65 in web. Typecheck is clean across all six workspaces. The
major security findings from the last audit are closed — centralized SSRF
protection, nonce-based CSP, bounded proxy trust, constant-time secret comparison,
JWT audience and issuer pinning, and raw-byte webhook signature verification. The
production deploy path is now commit-pinned with rollback.

**What holds it back.**

1. **No automatic CI.** The quality gate exists but never fires. This is the single
   most consequential gap: every other guarantee in this document can regress
   silently between merges.
2. **Production is not traceable to a commit.** The live Azure VM is healthy but was
   hand-built. The new workflow fixes this prospectively and has not been used yet.
3. **Committed infrastructure metadata.** `supabase/.temp/` is still git-tracked,
   and two stale agent worktree snapshots under `.claude/worktrees/` duplicate it.
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

**Test count — was 139, is now 523+65.** Measured per workspace: api 64 files / 437
tests, shared 6 / 18, livekit-agent 1 / 3, web 12 files / 65 tests.

## Implemented versus configured

Feature completeness in code does not mean the capability is live. These three are
worth stating plainly.

**LiveKit / BYO telephony.** Implemented and tested. All LiveKit env vars are
optional (`apps/api/src/config/env.ts:52-59`); the deploy runs the `livekit` compose
profile only when all three credentials are present and aborts on a partial set
(`.github/workflows/deploy-azure-vm.yml:197-206`). Production configuration is
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
non-`live` mode (`apps/web/lib/billing-mode.ts:22-30`). The Azure deploy requires
`BILLING_MODE=live` and non-empty Stripe variables
(`.github/workflows/deploy-azure-vm.yml:170-171,189`), so a successful deploy implies
live billing.

## Open work, prioritized

### P0 — process and secrets

**1. Add automatic CI.** Create a workflow triggered on `pull_request` and pushes to
protected branches, running the existing gate from `ci-cd-ec2.yml:34-76` (gitleaks,
`pnpm audit --prod --audit-level=high`, Prisma generate, shared build, typecheck,
lint, test). Mark it a required status check. Keep all deploy workflows
dispatch-only. Without this, nothing else on this list stays fixed.

**2. Untrack and purge `supabase/.temp/` and `.claude/worktrees/`.** Nine files are
still tracked under `supabase/.temp/`, including `pooler-url`, `project-ref`, and
`linked-project.json`. A second copy of the same directory is committed inside a
stale agent worktree snapshot at `.claude/worktrees/` (67 tracked paths across two
snapshots, also containing deploy scripts and a chat transcript). Cleaning up only
one location would miss the other. Remove both from the index, add them to
`.gitignore`, and purge from history in a single pass. A scan of the committed
worktrees found no credential values, only infrastructure metadata and tooling, so
rotation is precautionary rather than urgent — but rotate the database password if
there is any doubt about what transited those directories.

**3. Perform one deploy through `deploy-azure-vm.yml`.** This establishes the first
verifiable commit-to-production mapping and exercises the rollback path before it is
needed in an incident.

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

**8. Pin the package manager.** Add `"packageManager": "pnpm@10.33.2"` to the root
`package.json`. It is currently pinned only in workflow env
(`.github/workflows/ci-cd-ec2.yml:27`), which is how the lockfile/overrides mismatch
became possible in the first place.

**9. Declare `express` in `apps/api/package.json`.** It is used transitively via
`@nestjs/platform-express` hoisting. `main.ts` no longer imports it directly
(`apps/api/src/main.ts:3,31,78-80`), so this is latent — but it depends on a hoisting
layout that is not guaranteed.

**10. Convert knowledge search from GET to POST** so query terms stop landing in
access logs.

**11. Superseded audit docs — done in this pass.** `docs/SECURITY_AUDIT.md` and
`docs/WEB_SECURITY_AUDIT.md` described a Clerk-era codebase and have been reduced to
pointers at `VOICEFORGE_AUDIT_REPORT.md`.

**12. Fix stale landing-page copy — done.** The landing page now describes the
OpenAI Realtime and in-house Azure pipelines instead of a mock runtime and
"Retell-ready", and the privacy policy lists Microsoft Azure, OpenAI, and
LiveKit as subprocessors in place of Vapi.

### P3 — consolidation

**13. Remove the GCP and EC2 workflows** once those paths are decommissioned. Azure
is the sole production target; the others are dispatch-gated but remain live surface
area. Externalize the AWS account ids in `infra/docker/docker-compose.prod.yml` if
that file outlives the migration.

**14. Runtime-verify the operational assets.** `scripts/backup-validation.js`,
`docs/RUNBOOK.md`, `docs/35_BACKUP_RECOVERY.md`, and the k6 suites all exist but none
were runtime-verified. A restore drill is the only way to know the backup story
works.

## What would make this 10/10

In order: automatic CI as a required check; one traceable production deploy;
`supabase/.temp/` purged and credentials rotated; and a completed backup restore
drill. The cross-tenant sweep, the route-guard ratchet, and the `apps/voice-edge`
decision are done. None of the remainder is feature work. The product is built —
what is missing is the machinery that proves it stays built.
