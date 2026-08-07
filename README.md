# VoiceForge AI

A Lovable-style AI voice calling agent builder for agencies and appointment-based businesses.
Users describe their need in natural language; VoiceForge generates a full agent
(voice persona, call flow, knowledge base, tools, compliance settings, analytics,
and white-label client dashboards).

> Authoritative product docs live under `docs/`. See `AGENTS.md` for the build
> rules and `docs/README-order.md` (README at `docs/..`, listing 30+ docs) for
> the full reading order.

## Monorepo layout

```txt
voice-agent-builder/
  apps/
    web/        Next.js 16 + React 19 + Tailwind 4 frontend
    api/        NestJS backend (Prisma + Postgres + BullMQ)
  packages/
    shared/     Zod schemas, DTOs, types, template seed data
    ui/         Shared UI primitives (placeholder)
  docs/         Full VoiceForge AI product documentation
```

Package manager: **pnpm workspaces** (Node >= 20.11).

## Stack decisions

| Concern | Choice |
| ------- | ------ |
| Frontend | Next.js 16 + React 19 + Tailwind 4 |
| Backend | NestJS 10 |
| Database | Supabase Postgres via Prisma |
| Queues | Redis/Valkey + BullMQ |
| Auth | Supabase Auth with verified JWT audience and issuer |
| Voice | Vapi, Retell, Twilio/LiveKit, and OpenAI Realtime adapters; mock for development |
| LLM | GitHub, OpenAI, Anthropic, and Azure AI Foundry adapters |
| Validation | Shared Zod schemas at API and UI boundaries |

Per `AGENTS.md`, all provider integrations go through adapter interfaces so
production providers can be swapped in without changing business logic.

## LiveKit BYO phone numbers

VoiceForge now supports Twilio and Vobiz BYO phone-number routing through
LiveKit SIP and OpenAI Realtime `gpt-realtime-2`.

Start with:

- `docs/byo-phone-numbers.md`
- `docs/livekit-telephony.md`
- `docs/twilio-setup.md`
- `docs/vobiz-setup.md`

Required backend env vars are documented in `.env.example`.

## Dev quickstart

1. **Create a Supabase project** (free tier works). Grab:
   - Pooler connection string \u2192 `DATABASE_URL` (port `6543`, `?pgbouncer=true`)
   - Direct connection string \u2192 `DIRECT_URL` (port `5432`)

2. **Copy envs** and configure Supabase, Redis, security keys, explicit CORS origins,
   and the selected production voice provider:

   ```powershell
   Copy-Item .env.example .env
   # edit .env and paste your Supabase URLs
   ```

3. **Install & push schema**:

   ```powershell
   pnpm install
   pnpm db:generate
   pnpm db:push    # uses DIRECT_URL; creates all tables in Supabase
   pnpm db:seed    # seeds the MVP agent templates
   ```

4. **Run both apps**:

   ```powershell
   pnpm dev
   ```

   - API \u2192 <http://localhost:4000/api/v1> (health: `/health`)
   - Web \u2192 <http://localhost:3000>

5. **Demo flow**: sign up \u2192 `/dashboard/agents/new` \u2192 paste a prompt like
   "Create an AI receptionist for a dental clinic that books appointments and
   transfers emergencies" \u2192 pick the `dental-receptionist` template \u2192
   Generate \u2192 Save as draft \u2192 view Agent Spec JSON on the builder page.

## Scripts

| Command              | What it does                                      |
| -------------------- | ------------------------------------------------- |
| `pnpm dev` | Runs `@voiceforge/api` and `@voiceforge/web` in parallel |
| `pnpm build` | Builds shared, API, and web in order |
| `pnpm typecheck` | Type-checks all workspaces |
| `pnpm lint` | Runs ESLint across all workspaces |
| `pnpm test` | Runs Vitest across all workspaces |
| `pnpm db:push` | Applies the Prisma schema through `DIRECT_URL` |
| `pnpm db:seed` | Seeds the MVP agent templates |

## Status

The MVP phases are implemented end to end:

- Agent Spec JSON generation, CRUD/versioning, templates, and visual builder.
- Workspace- and agent-scoped knowledge ingestion, maintained PDF extraction,
  embeddings, and POST-based retrieval.
- Provider-neutral voice runtimes with Vapi, Retell, Twilio/LiveKit, OpenAI
  Realtime, and a non-production mock.
- Test/outbound calls, signed and replay-protected webhooks, transcripts,
  recordings, event deduplication, evaluations, and analytics.
- Permissioned tools, calendar/CRM integrations, centralized SSRF protection,
  compliance and consent gates, audit logs, billing, and white-label features.
- Hardened CI/deployment with secret scanning, dependency auditing, AWS OIDC,
  pinned SSH host keys, trusted TLS certificates, and private observability.

See `docs/20_IMPLEMENTATION_ROADMAP.md` and `docs/21_TASK_BACKLOG.md` for the
historical phase breakdown; code and current tests are the source of truth.
