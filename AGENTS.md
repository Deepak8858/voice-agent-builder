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
10. Mock external providers first if credentials are unavailable, but preserve real interfaces.

## Preferred Architecture
```txt
apps/web         Next.js frontend
apps/api         NestJS backend
packages/shared  shared schemas, types, validation
packages/ui      shared UI components if needed
docs             product/build documentation
```

## Build Order
1. Project setup and monorepo
2. Auth and workspace model
3. Agent Spec JSON schema
4. Agent CRUD/versioning
5. Prompt-to-agent mock generator
6. Templates
7. Frontend builder UI
8. Mock voice runtime
9. Calls dashboard
10. Compliance engine
11. White-label settings
12. Billing placeholder
13. Real Vapi/Retell adapter

## First Working Demo
```txt
Sign up → create workspace → generate agent from prompt → view Agent Spec JSON → test mock call → publish mock agent → view call transcript → see analytics → configure white-label branding
```

