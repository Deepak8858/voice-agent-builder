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
| Voice | OpenAI Realtime, LiveKit, Twilio; Vapi and Retell are removed and their config is ignored with a warning (`apps/api/src/config/env.ts:16-23,528-537`); mock is rejected in production (`env.ts:37,302-308`) |
| LLM | Provider adapters under `apps/api/src/llm/` |
| Validation | Shared Zod schemas via `@voiceforge/shared` |

Clerk is gone. Any remaining reference to Clerk in `docs/` is historical.

## Implemented in code vs. configured in production

This distinction matters and was previously blurred. "Implemented" means the code
path exists and is tested. "Configured" means the production environment actually
supplies the credentials to run it.

**LiveKit / BYO telephony — implemented; production configuration unverified.**
`apps/livekit-agent/` and `apps/api/src/livekit/` exist and are tested. All LiveKit
env vars are optional (`apps/api/src/config/env.ts:77-84`). The AWS deploy enables
LiveKit only when `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are
all present in `/opt/voiceforge/.env`, and aborts on a partial set
(`.github/workflows/deploy-aws-ec2.yml:488-497`). Whether production supplies them
cannot be determined from this repo — the deploy validates a host env file it does
not write.

**Email — implemented; delivery unconfigured by default, and not scheduled.**
`EmailService` sends via Resend and returns
`{ status: 'skipped', reason: 'email_not_configured' }` when `RESEND_API_KEY` is
absent (`apps/api/src/email/email.service.ts:164-170`). The weekly digest is fully
built, tenant-scoped to owners/admins, and non-throwing per recipient
(`email.service.ts:164-242`) — but **nothing calls it**. There is no
`@nestjs/schedule` dependency and no cron registration anywhere in `apps/api/src`;
`sendWeeklyDigest` has no non-test caller. It is a complete feature with no
trigger.

**Billing — implemented; live or unavailable, with no demo mode.** There is no
`BILLING_MODE` variable and no demo billing path: missing configuration never
grants a free allowance, it returns 503. All `STRIPE_*` variables are optional at
boot, so each entry point is gated at request time on the variables it actually
needs — subscription checkout, minute-pack top-up and the customer portal have
separate lists (`apps/api/src/config/env.ts:425-471`,
`apps/api/src/billing/billing.service.ts:337-354`), so one unset price ID
disables one action rather than all three. A production boot warns which actions
are disabled and names the missing variables (`env.ts:539-563`), and the deploy
gate refuses to proceed unless the host env sets all five plus a live-mode secret
key (`.github/workflows/deploy-aws-ec2.yml:435-436,460-462`). A successful
production deploy therefore implies live billing was configured.

**Google Calendar — implemented, including token refresh.** Tokens are encrypted
at rest (`apps/api/src/calendar/calendar.service.ts:44-45`), refreshed ahead of
expiry with a 60s skew (`calendar.service.ts:13,132-144`), de-duplicated across
concurrent callers via an in-flight map (`calendar.service.ts:30,150-165`), and
exchanged through a dedicated OAuth client
(`apps/api/src/calendar/google-oauth.client.ts:32-99`). Requires
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to be set.

## Production deployment

The production target is AWS EC2. Azure and GCP are gone: `deploy-azure-vm.yml`,
`deploy-gcp.yml` and `ci-cd-ec2.yml` no longer exist, and `.github/workflows/`
now holds exactly two files — `deploy-aws-ec2.yml` and `quality-gate.yml`. Any
older reference to an Azure VM, an Azure Container Registry or a staging
environment in `docs/` is historical; no ACR ever existed.

`.github/workflows/deploy-aws-ec2.yml` is operator-initiated
(`workflow_dispatch` only, lines 21-31) and:

- requires a typed `deploy-production` confirmation and a full 40-character SHA
  (lines 24-31);
- builds API, web and LiveKit images on Depot via GitHub OIDC, with no static
  cloud tokens (lines 20, 88, 231);
- **validates a hand-maintained `/opt/voiceforge/.env` on the host — it does not
  write it.** The file must already exist and be non-empty (line 416); values are
  read with an `awk` helper (lines 426-428) and 27 required names are checked
  (lines 429-440), rejecting a test-mode `STRIPE_SECRET_KEY` and reporting
  offenders **by name only** (lines 483-486);
- requires all three LiveKit variables or none (lines 488-497);
- keeps the previous release bundle for rollback (lines 520-528).

Because the workflow validates rather than writes the host env file, **the env
files in this repository are not the deployed configuration** and nothing here
can tell you what the running instance is set to.

## CI status

Automatic CI exists. `.github/workflows/quality-gate.yml` runs on every pull
request and on pushes to `main` (lines 13-17): gitleaks secret scanning,
`pnpm audit --prod --audit-level=high`, typecheck, lint, test, plus a web image
build. It never deploys and needs no cloud credentials.

One hazard: `.depot/workflows/quality-gate.yml` is a near-duplicate of it. A
change applied to one and not the other drifts silently.

## Known toolchain issues

**Resolved on this branch: lockfile/overrides drift.** Ten security-pin overrides
were added to the root `package.json` without being recorded in the lockfile, which
breaks CI's `pnpm install --frozen-lockfile` with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. The lockfile has since been regenerated and
now matches: `package.json:33-44` and `pnpm-lock.yaml:7-17` agree on all ten pins.
Any future change to `pnpm.overrides` must regenerate the lockfile in the same
commit.

**Resolved: pnpm version is pinned.** `package.json:32` declares
`"packageManager": "pnpm@10.33.2"`, so a local install and CI resolve the same
pnpm. The Node floor is pinned separately in `quality-gate.yml:23-46` with the
dependency constraints that set it.

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
   rejected in production (`apps/api/src/config/env.ts:302-308`).
4. **Security keys** — `JWT_SECRET` (min 32 chars, must not be the development
   default in production, `env.ts:161-167`), `ENCRYPTION_KEY`, `INTERNAL_API_KEY`,
   `VOICE_WEBHOOK_SECRET`, and explicit `ALLOWED_ORIGINS`; the last two are
   required non-empty in production (`env.ts:288-301`).
5. **Optional integrations** — `RESEND_API_KEY` for email, `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` for calendar, the five `STRIPE_*` variables for billing
   (secret key, webhook secret, starter/growth/minute-pack price IDs — there is no
   `BILLING_MODE`), and the three LiveKit variables for BYO telephony.

Concrete hostnames, IP addresses, project references, and connection strings are
deliberately excluded from this file. They belong in the deployment environment and
secret store.

## Next steps

See `ROADMAP.md` for the prioritized list. The top three:

1. Read `/opt/voiceforge/.env` on the running instance and record whether
   `STRIPE_SECRET_KEY` is live-mode and `STRIPE_MINUTE_PACK_PRICE_ID` is set. The
   deploy gate validates that file but never writes it, so nothing in this
   repository answers the question.
2. Perform one deployment through `deploy-aws-ec2.yml` to establish a traceable
   commit-to-production mapping.
3. Keep `.depot/workflows/quality-gate.yml` and `.github/workflows/quality-gate.yml`
   in sync, or delete one — they are near-duplicates that drift silently.
