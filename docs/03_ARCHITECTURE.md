# 03 — System Architecture

## High-Level Architecture
```txt
Next.js Frontend
  ↓
NestJS API
  ├─ Auth/Tenant Module
  ├─ Agent Builder Module
  ├─ Template Module
  ├─ Knowledge Module
  ├─ Voice Runtime Adapter
  ├─ Tool Registry
  ├─ Compliance Engine
  ├─ Call/Event Service
  ├─ Analytics Service
  ├─ Billing Service
  └─ Audit Service
  ↓
PostgreSQL + Redis + S3/R2 + ClickHouse + Vector DB
  ↓
External Providers: Vapi/Retell/OpenAI/Twilio/Telnyx/Stripe/Google/HubSpot/Webhooks
```

## Core Design Decision
Store provider-neutral agent logic in **Agent Spec JSON**, then compile it into provider-specific runtime configuration.

## Key Data Flows
### Generate Agent
`Prompt + template → LLM/generator → Agent Spec JSON → validation → save draft/version → preview UI`

### Publish Agent
`Agent version → validate → compile runtime config → create/update provider agent → save provider runtime ID → mark published`

### Inbound Call
`Phone call → voice provider → provider webhook/tool calls → backend tool registry → events/transcript/recording → analytics`

### Outbound Call
`Outbound request → compliance engine → queue job → voice provider → call events → billing usage`

## Scaling Path
MVP: modular monolith. Growth: workers for voice webhooks, analytics, embeddings, billing. Scale: split voice orchestration, analytics, compliance, and integrations into services if needed.
