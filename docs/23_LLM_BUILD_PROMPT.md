# 23 — LLM Build Prompt

Use this prompt in Cursor, Claude Code, Replit Agent, or another coding agent.

## Prompt
You are building **VoiceForge AI**, a production-grade SaaS platform where users create AI voice calling agents using natural language.

Read all docs in this repository before coding. Follow `AGENTS.md` strictly.

Build a monorepo:
```txt
apps/web        Next.js frontend
apps/api        NestJS backend
packages/shared shared schemas/types
```

Use:
```txt
Frontend: Next.js + TypeScript + Tailwind + shadcn/ui + React Flow
Backend: NestJS + TypeScript + PostgreSQL + Prisma/Drizzle + Redis
Validation: Zod
Voice: Mock provider first, then adapter pattern for Vapi/Retell
Billing: Stripe abstraction
```

First implementation target:
1. Auth placeholder or Clerk setup
2. Workspace CRUD
3. Agent CRUD
4. Agent Spec JSON schema
5. Prompt-to-agent mock generator
6. Template selector
7. Agent builder UI
8. Mock voice test session
9. Calls dashboard
10. Compliance check service
11. White-label settings page
12. Billing placeholder

Never skip workspace authorization, Agent Spec validation, compliance checks for outbound calls, tool call logging, or audit logs.

The first build is complete when a user can create a workspace, generate an agent, test it through a mock call, publish it to a mock provider, view transcript/analytics, run compliance check, and configure white-label branding.
