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
4. **Coverage holes in exactly the wrong places.** `apps/voice-edge` — live audio
   handling — has no tests, and there is no systematic cross-tenant authorization
   test despite tenant isolation being enforced in application code.

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

**Free tier — fixed.** The free plan grants 10 consumable trial minutes, 5 trial
outbound calls, 1 agent, and 50 contacts
(`packages/shared/src/schemas/billing.ts:35-43`).

**Visual flow builder — exists.** `apps/web/components/flow-builder/` contains the
client, model, node palette, config panel, and typed node components, with model
tests at `flow-builder-model.test.ts`.

**Pricing page — exists.** `apps/web/app/pricing/page.tsx`.

**Public agent share pages — exist.** `apps/web/app/a/[slug]/page.tsx`.

**Referral system — exists.** `apps/api/src/referral/` with controller, service, and
module, plus schema backing.

**Own voice pipeline — exists.** `apps/voice-edge/` implements the Twilio Media
Streams bridge with session store, prompt builder, audio utils, and a Dockerfile.
It has no tests, which is its main problem.

**Retell adapter — exists.** `apps/api/src/voice/adapters/retell.adapter.ts` with
tests, registered in `voice-provider.registry.ts`.

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
`RESEND_API_KEY` (lines 165-170). But **no scheduler invokes it** — there is no
`@nestjs/schedule` dependency, no cron registration, and no non-test caller of
`sendWeeklyDigest`. A finished feature with no trigger.

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

**4. Cross-tenant authorization test sweep.** Assert that every workspace-scoped
query filters by `workspaceId`. Tenant isolation is enforced in application code
against a privileged database connection, so one missing `where` clause is a
cross-tenant leak. This is the highest-value test in the repository.

**5. Test `apps/voice-edge`.** Zero tests on the component that handles live audio
and Twilio Media Streams. At minimum cover audio framing, session lifecycle, and
prompt construction.

**6. Include `apps/web` in the root `test` script.** It has 12 test files that the
local gate skips. CI's `pnpm -r --if-present run test` picks them up, but developers
running `pnpm test` locally get a false green.

**7. Schedule the weekly digest, or remove it.** Either add a scheduler and wire
`sendWeeklyDigest`, or delete the feature. Shipping unreachable code is worse than
either.

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

**12. Fix stale landing-page copy.** `apps/web/app/page.tsx:97` says "Mock runtime
comes first" and line 127 lists "Mock voice runtime" and "Retell-ready". Retell is a
real, tested adapter and mocks are dev-only. The copy undersells the product and
contradicts `AGENTS.md` rule 10.

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
`supabase/.temp/` purged and credentials rotated; a cross-tenant authorization test
sweep; tests on `apps/voice-edge`; and a completed backup restore drill. None of
these are feature work. The product is built — what is missing is the machinery that
proves it stays built.
