# AGENTS.md — Instructions for LLM Coding Agents

## Mission
Build **VoiceForge AI**, a multi-tenant SaaS platform where users create, test, deploy, monitor, and white-label AI voice calling agents using natural language.

## Non-Negotiable Rules
1. Agent Spec JSON is the central contract. Do not build raw-prompt-only logic.
2. Multi-tenancy is mandatory. Every customer record must be scoped by workspace or organization.
3. No outbound call may run without compliance checks.
4. Do not hard-code one voice provider. Build a provider adapter interface.
5. All tool calls must be validated, permissioned, idempotent where possible, and logged.
6. All critical actions must create audit logs.
7. Use TypeScript strict mode.
8. Use Zod or equivalent runtime validation.
9. Use PostgreSQL as source of truth.
10. Mock providers exist for credential-less local development and tests, and are rejected at boot in production. `apps/api/src/config/env.ts:16-17` states the policy and `env.ts:142-148` enforces it: `VOICE_PROVIDER=mock` fails validation when `NODE_ENV=production`. Real adapters are the only production path.

## Preferred Architecture
```txt
apps/web         Next.js frontend
apps/api         NestJS backend
packages/shared  shared schemas, types, validation
packages/ui      shared UI components if needed
docs             product/build documentation
```

## Toolchain
The repo is pnpm-native. Use `corepack` + `pnpm` (the root `package.json` and `.github/workflows/quality-gate.yml:29` pin `10.33.2`). Do not use `npm install` at the root: workspace dependencies are declared with the `workspace:*` protocol, which npm cannot resolve. Do not convert them.
When changing `pnpm.overrides` in the root `package.json`, regenerate `pnpm-lock.yaml` in the same commit. CI installs with `--frozen-lockfile` and fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` if the two drift.
## Build Order
Build order 1-13 below is the historical MVP sequence and is complete. It is retained for context only; new work is tracked in `ROADMAP.md`.
1. Project setup and monorepo
2. Auth and workspace model
3. Agent Spec JSON schema
4. Agent CRUD/versioning
5. Prompt-to-agent generator
6. Templates
7. Frontend builder UI
8. Voice runtime
9. Calls dashboard
10. Compliance engine
11. White-label settings
12. Billing
13. Real voice runtime adapters

Since the MVP sequence closed, Vapi and Retell were removed entirely. The two
supported runtimes are OpenAI Realtime (paid plans) and the in-house `standard`
pipeline (Azure Speech STT → Azure OpenAI chat → Azure Speech TTS) in
`apps/livekit-agent`, which is the only runtime the free plan may use. Rule 4
still holds: route through the adapter interface and `PipelineRouterService`
rather than hard-coding either runtime.

## First Working Demo
```txt
Sign up → create workspace → generate agent from prompt → view Agent Spec JSON → test call → publish agent → view call transcript → see analytics → configure white-label branding
```

