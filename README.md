# VoiceForge AI

A multi-tenant AI voice calling agent builder for agencies and appointment-based
businesses. Users describe their need in natural language; VoiceForge generates a
full agent (voice persona, call flow, knowledge base, tools, compliance settings,
analytics, and white-label client dashboards).

> Authoritative product docs live under `docs/`. `AGENTS.md` holds the build
> rules. `ROADMAP.md` holds the current, evidence-based assessment of what is
> built and what is genuinely open. Where docs and code disagree, code wins.

## Monorepo layout

```txt
voice-agent-builder/
  apps/
    web/            Next.js 16 + React 19 + Tailwind 4 frontend
    api/            NestJS backend (Prisma + Postgres + BullMQ)
    livekit-agent/  LiveKit voice agent worker (OpenAI Realtime + in-house Azure pipeline)
  packages/
    shared/         Zod schemas, DTOs, types, template seed data
    ui/             Shared UI primitives
  docs/             VoiceForge AI product documentation
  infra/            Docker, nginx, and deployment assets
```

Package manager: **pnpm workspaces** (Node >= 20.11). Workspace dependencies use
the `workspace:*` protocol, so `npm install` will not resolve this repo — use
`corepack` + `pnpm` (workflows pin `10.33.2`, `.github/workflows/ci-cd-ec2.yml:27`).

## Stack

| Concern | Choice |
| ------- | ------ |
| Frontend | Next.js 16 + React 19 + Tailwind 4 |
| Backend | NestJS 10 |
| Database | Supabase Postgres via Prisma |
| Queues | Redis/Valkey + BullMQ |
| Auth | Supabase Auth, JWT verified with pinned algorithm, audience, and issuer (`apps/api/src/auth/supabase-auth.service.ts:119-123`) |
| Voice | OpenAI Realtime and the in-house `standard` Azure pipeline via LiveKit, plus a dev-only mock (`apps/api/src/voice/adapters/`) |
| LLM | Provider adapters under `apps/api/src/llm/` |
| Validation | Shared Zod schemas at API and UI boundaries |

Per `AGENTS.md`, all provider integrations go through adapter interfaces.
The mock voice provider is available for credential-less local development and
tests, and is rejected at boot in production (`apps/api/src/config/env.ts:142-148`).

## LiveKit BYO phone numbers

Twilio and Vobiz BYO phone-number routing is implemented in code through LiveKit
SIP and OpenAI Realtime. This is **implemented, not necessarily provisioned**: the
LiveKit variables are optional in config (`apps/api/src/config/env.ts:52-59`), and
the production deploy only starts the LiveKit profile when all three of
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are present — a partial
set aborts the deploy (`.github/workflows/deploy-azure-vm.yml:197-206`).

Start with:

- `docs/byo-phone-numbers.md`
- `docs/livekit-telephony.md`
- `docs/twilio-setup.md`
- `docs/vobiz-setup.md`

Required backend env vars are documented in `.env.example`.

## Dev quickstart

1. **Create a Supabase project.** Take the pooler connection string for
   `DATABASE_URL` (port `6543`, `?pgbouncer=true`) and the direct connection
   string for `DIRECT_URL` (port `5432`).

2. **Copy envs** and configure Supabase, Redis, security keys, explicit CORS
   origins, and the voice provider:

   ```powershell
   Copy-Item .env.example .env
   ```

3. **Install & push schema**:

   ```powershell
   corepack pnpm install
   pnpm db:generate
   pnpm db:push    # uses DIRECT_URL
   pnpm db:seed    # seeds the MVP agent templates
   ```

4. **Run both apps**:

   ```powershell
   pnpm dev
   ```

   - API → <http://localhost:4000/api/v1> (health: `/health`)
   - Web → <http://localhost:3000>

5. **Demo flow**: sign up → `/dashboard/agents/new` → paste a prompt like
   "Create an AI receptionist for a dental clinic that books appointments and
   transfers emergencies" → pick the `dental-receptionist` template → Generate →
   Save as draft → view Agent Spec JSON on the builder page.

## Scripts

| Command | What it does |
| ------- | ------------ |
| `pnpm dev` | Runs `@voiceforge/api` and `@voiceforge/web` in parallel |
| `pnpm build` | Builds shared, API, and web in order |
| `pnpm typecheck` | Type-checks all five workspaces |
| `pnpm lint` | Lints `@voiceforge/api` and `@voiceforge/web` |
| `pnpm test` | Runs Vitest for shared, API, livekit-agent, and web |
| `pnpm db:push` | Applies the Prisma schema through `DIRECT_URL` |
| `pnpm db:seed` | Seeds the MVP agent templates |

The root `test` script covers every workspace that has a suite, so a local
`pnpm test` matches what CI's `pnpm -r --if-present run test` runs. It previously
omitted `apps/web`, which made a local green misleading.

## Status

The MVP phases are implemented end to end: agent generation and versioning,
templates, a visual flow builder, knowledge ingestion and retrieval,
provider-neutral voice runtimes, calls and transcripts, signed and
replay-protected webhooks, evaluations, analytics, permissioned tools, calendar
and CRM integrations with centralized SSRF protection, compliance and consent
gates, audit logs, billing, and white-label features.

Production runs on a single Azure VM. Deployment is operator-initiated only:
there is no push- or PR-triggered pipeline in this repo — all three workflows are
`workflow_dispatch`-gated (`ci-cd-ec2.yml:13-14`, `deploy-gcp.yml:5-6`,
`deploy-azure-vm.yml:5-12`).

For the current evidence-based assessment, including what is configured in
production versus merely implemented in code, see `ROADMAP.md` and `status.md`.
`docs/20_IMPLEMENTATION_ROADMAP.md` and `docs/21_TASK_BACKLOG.md` are historical.
