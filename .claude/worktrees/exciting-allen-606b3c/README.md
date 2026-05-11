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

Package manager: **npm workspaces** (Node >= 20.11).

## Stack decisions (Phase 0 / Phase 1)

| Concern   | Choice                                               |
| --------- | ---------------------------------------------------- |
| Frontend  | Next.js 16 + React 19 + Tailwind 4                   |
| Backend   | NestJS 10                                            |
| Database  | **Supabase Postgres** (via Prisma)                   |
| Queues    | **AWS-hosted Redis** + BullMQ (stub when no `REDIS_URL`) |
| Auth      | Mock (cookie session) \u2014 Clerk adapter stubbed           |
| Voice     | Mock provider \u2014 Vapi/Retell adapters stubbed            |
| LLM       | Mock prompt-to-agent generator                       |
| Validation| Zod (shared between API & web)                       |

Per `AGENTS.md`, all provider integrations go through adapter interfaces so
production providers can be swapped in without changing business logic.

## Dev quickstart

1. **Create a Supabase project** (free tier works). Grab:
   - Pooler connection string \u2192 `DATABASE_URL` (port `6543`, `?pgbouncer=true`)
   - Direct connection string \u2192 `DIRECT_URL` (port `5432`)

2. **Copy envs** and fill in the two Supabase URLs (Redis optional for now):

   ```powershell
   Copy-Item .env.example .env
   # edit .env and paste your Supabase URLs
   ```

3. **Install & push schema**:

   ```powershell
   npm install
   npm run db:generate
   npm run db:push    # uses DIRECT_URL; creates all tables in Supabase
   npm run db:seed    # seeds the 5 MVP agent templates
   ```

4. **Run both apps**:

   ```powershell
   npm run dev
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
| `npm run dev`        | Runs `@voiceforge/api` and `@voiceforge/web` in parallel |
| `npm run build`      | Builds shared \u2192 api \u2192 web in order                 |
| `npm run typecheck`  | TS check across all workspaces                    |
| `npm run lint`       | ESLint across all workspaces                      |
| `npm run test`       | Vitest across all workspaces                      |
| `npm run db:push`    | Apply Prisma schema to Supabase via `DIRECT_URL`  |
| `npm run db:seed`    | Seed MVP agent templates                          |

## Status

Phases 0\u20135 are implemented:

- **Phase 0** \u2014 monorepo, infra, env, Prisma schema, BullMQ stub.
- **Phase 1** \u2014 Agent Spec JSON, CRUD, mock prompt-to-agent generator, builder UI.
- **Phase 2** \u2014 templates seeded, knowledge ingest (text/url/file), PDF/CSV/TXT
  parsing, embedding provider adapters (mock + OpenAI stub), cosine retrieval
  search endpoint, builder UI for upload + retrieval test.
- **Phase 3** \u2014 voice runtime adapter interface, mock + Vapi/Retell stubs,
  test sessions, call events/transcripts.
- **Phase 4** \u2014 publish flow, voice webhook controller, post-call evaluations.
- **Phase 5** \u2014 tool registry, webhook executor, input validator, integrations UI.

Phase 6 onwards (compliance, analytics, white-label, billing, hardening) is
not yet implemented \u2014 see `docs/20_IMPLEMENTATION_ROADMAP.md`.
