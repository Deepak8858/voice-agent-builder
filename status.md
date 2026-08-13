# VoiceForge AI — Status

_Reconciled against `integration/prod-readiness` at commit `a3deeb3`._

This document records verified state only. Every claim below is either backed by
a `path:line` citation or explicitly labelled as unverified. Historical changelog
entries were removed rather than retained: they described a Clerk-era, npm-based,
139-test codebase that no longer exists, and they carried infrastructure
identifiers that do not belong in a tracked file.

## TL;DR

All MVP phases and the bulk of the production-hardening work are implemented in
code. The remaining risk is not feature completeness — it is the gap between what
is implemented and what is actually configured, plus the absence of any automatic
CI gate. See `ROADMAP.md` for the prioritized open list.

## Verified baseline

Test counts measured with a real `pnpm install` on this branch:

- `apps/api` — 64 test files, 437 tests passing.
- `packages/shared` — 6 test files, 18 tests passing.
- `apps/livekit-agent` — 1 test file, 3 tests passing.
- `apps/web` — 10 test files, 65 tests passing.
- `pnpm typecheck` — clean across all six workspaces.
- `pnpm --filter @voiceforge/api exec eslint "src/**/*.ts"` — exits 0.

The previously documented "139 / 139 passing" figure was stale by a wide margin
and has been removed.

Note a gap in the local gate: the root `test` script runs shared, api, and
livekit-agent only, so `apps/web`'s suite is skipped locally. CI's
`pnpm -r --if-present run test` (`.github/workflows/ci-cd-ec2.yml:76`) does include
it.

## Current stack

| Layer | Choice |
| ----- | ------ |
| Frontend | Next.js 16 + React 19 + Tailwind 4 |
| Backend | NestJS 10 on Express (`apps/api/src/main.ts:3,31`) |
| Database | Supabase Postgres via Prisma |
| Queues | BullMQ + ioredis; in-process fallback when `REDIS_URL` is unset |
| Auth | Supabase Auth; JWT verified with pinned algorithm, `audience`, and `issuer` (`apps/api/src/auth/supabase-auth.service.ts:119-123`) |
| Voice | Vapi, Retell, OpenAI Realtime, LiveKit; mock is dev/test only (`apps/api/src/config/env.ts:16-17,142-148`) |
| LLM | Provider adapters under `apps/api/src/llm/` |
| Validation | Shared Zod schemas via `@voiceforge/shared` |

Clerk is gone. Any remaining reference to Clerk in `docs/` is historical.

## Implemented in code vs. configured in production

This distinction matters and was previously blurred. "Implemented" means the code
path exists and is tested. "Configured" means the production environment actually
supplies the credentials to run it.

**LiveKit / BYO telephony — implemented; production configuration unverified.**
`apps/livekit-agent/` and `apps/api/src/livekit/` exist and are tested. All LiveKit
env vars are optional (`apps/api/src/config/env.ts:52-59`). The Azure deploy starts
the `livekit` compose profile only when `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
`LIVEKIT_API_SECRET` are all present, and aborts on a partial set
(`.github/workflows/deploy-azure-vm.yml:197-206`). Whether production supplies them
cannot be determined from this repo.

**Email — implemented; delivery unconfigured by default, and not scheduled.**
`EmailService` sends via Resend and returns
`{ status: 'skipped', reason: 'email_not_configured' }` when `RESEND_API_KEY` is
absent (`apps/api/src/email/email.service.ts:164-170`). The weekly digest is fully
built, tenant-scoped to owners/admins, and non-throwing per recipient
(`email.service.ts:164-242`) — but **nothing calls it**. There is no
`@nestjs/schedule` dependency and no cron registration anywhere in `apps/api/src`;
`sendWeeklyDigest` has no non-test caller. It is a complete feature with no
trigger.

**Billing — implemented; runs in demo mode unless explicitly switched.**
`BILLING_MODE` defaults to `demo` (`apps/api/src/config/env.ts:111`), and the web
client treats anything other than `live` as demo, disabling checkout
(`apps/web/lib/billing-mode.ts:22-30`). All `STRIPE_*` variables are optional in
config. The Azure deploy does require `BILLING_MODE=live` plus non-empty Stripe
variables before it will proceed (`.github/workflows/deploy-azure-vm.yml:170-171,189`),
so a successful production deploy implies live billing was configured.

**Google Calendar — implemented, including token refresh.** Tokens are encrypted
at rest (`apps/api/src/calendar/calendar.service.ts:44-45`), refreshed ahead of
expiry with a 60s skew (`calendar.service.ts:13,132-144`), de-duplicated across
concurrent callers via an in-flight map (`calendar.service.ts:30,150-165`), and
exchanged through a dedicated OAuth client
(`apps/api/src/calendar/google-oauth.client.ts:32-99`). Requires
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to be set.

## Production deployment

The live Azure VM deployment is **currently healthy but was built by hand and is
not traceable to a commit**. There is no recorded mapping from the running
containers to a source revision, so the deployed code cannot be verified from this
repository.

A traceable, operator-initiated replacement now exists at
`.github/workflows/deploy-azure-vm.yml`. It:

- requires a typed `deploy-production` confirmation and a full 40-character SHA
  (lines 12-15, 43-52);
- verifies the requested revision resolves to that exact commit (lines 55-60);
- requires all four SSH secrets and uses `StrictHostKeyChecking=yes` against a
  pinned `known_hosts` (lines 63-84, 96-100);
- builds registry-free images on the VM tagged with the commit SHA (lines 262-272);
- validates required production env var **names** without printing values
  (lines 163-195);
- runs migrations before replacement and rolls services back to the previously
  recorded SHA on failure (lines 274-282, 238-260);
- health-checks both loopback and public endpoints before recording success
  (lines 284-305).

This workflow has not yet been used for a production deploy. Doing so is the step
that closes the untraceability gap.

Earlier documentation claimed an Azure Container Registry and a staging
environment. **No ACR exists.** Those claims were false and have been deleted. The
Azure deploy builds images directly on the VM and never pushes to a registry
(`deploy-azure-vm.yml:3-4,262-272`).

## CI status

There is no automatic CI. All three workflows are `workflow_dispatch`-only:

- `.github/workflows/ci-cd-ec2.yml:13-14` — legacy AWS EC2 path, retained for
  decommissioning.
- `.github/workflows/deploy-gcp.yml:5-6`
- `.github/workflows/deploy-azure-vm.yml:5-12`

The quality gate — gitleaks secret scanning, `pnpm audit --prod --audit-level=high`,
typecheck, lint, test — is defined in `ci-cd-ec2.yml:34-76` but, because that
workflow is dispatch-only, **it never runs on a push or pull request**. Nothing
automatically blocks a bad merge. This is the single largest process gap and is
tracked in `ROADMAP.md`.

## Known toolchain issues

**Resolved on this branch: lockfile/overrides drift.** Ten security-pin overrides
were added to the root `package.json` without being recorded in the lockfile, which
breaks CI's `pnpm install --frozen-lockfile` with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. The lockfile has since been regenerated and
now matches: `package.json:33-44` and `pnpm-lock.yaml:7-17` agree on all ten pins.
Any future change to `pnpm.overrides` must regenerate the lockfile in the same
commit.

**Open: pnpm version is not pinned in the repo.** The root `package.json` has no
`packageManager` field. The version is pinned only in workflow env
(`.github/workflows/ci-cd-ec2.yml:27`), so local installs can silently use a
different pnpm than CI.

**Open, latent: phantom `express` dependency.** `express` is not declared in
`apps/api/package.json` — only `@nestjs/platform-express` (line 24) and
`@types/express` (line 62). It previously resolved through hoisting. `main.ts` no
longer imports it directly, using `NestExpressApplication` and `app.useBodyParser`
instead (`apps/api/src/main.ts:3,31,78-80`), so this is currently latent rather than
breaking. It should still be declared explicitly, since the current behaviour
depends on the hoisting layout.

## What the operator must supply

1. **Supabase project** — `DATABASE_URL` (pooler, port 6543) and `DIRECT_URL`
   (direct, port 5432).
2. **Redis/Valkey** — `REDIS_URL`. Leave empty for local dev to use the in-process
   fallback. In production the instance must be reachable on the private network,
   never exposed publicly.
3. **Voice provider credentials** — for the selected `VOICE_PROVIDER`. `mock` is
   rejected in production (`apps/api/src/config/env.ts:142-148`).
4. **Security keys** — `JWT_SECRET` (min 32 chars, must not be the development
   default in production, `env.ts:97-100`), `ENCRYPTION_KEY`, `INTERNAL_API_KEY`,
   `VOICE_WEBHOOK_SECRET`, and explicit `ALLOWED_ORIGINS`; the last two are
   required non-empty in production (`env.ts:128-141`).
5. **Optional integrations** — `RESEND_API_KEY` for email, `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` for calendar, `STRIPE_*` plus `BILLING_MODE=live` for
   real billing, and the three LiveKit variables for BYO telephony.

Concrete hostnames, IP addresses, project references, and connection strings are
deliberately excluded from this file. They belong in the deployment environment and
secret store.

## Next steps

See `ROADMAP.md` for the prioritized list. The top three:

1. Add a push/PR-triggered CI workflow so the existing quality gate actually runs.
2. Perform one deployment through `deploy-azure-vm.yml` to establish a traceable
   commit-to-production mapping.
3. Remove the still-tracked `supabase/.temp/` files, plus the duplicate copy inside
   the stale `.claude/worktrees/` snapshots, and rotate anything they describe.
