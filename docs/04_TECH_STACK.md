# 04 — Tech Stack

## Frontend
| Layer | Choice | Reason |
|---|---|---|
| App | Next.js + TypeScript | SaaS app, routing, SEO, dashboard |
| UI | Tailwind + shadcn/ui + Radix | Premium, accessible, white-labelable |
| Flow | React Flow | Node-based voice flow builder |
| Server state | TanStack Query | Reliable API state |
| Local state | Zustand | Builder/test session state |
| Forms | React Hook Form + Zod | Validated forms |
| Editor | Monaco | Agent JSON/tool schema editor |
| Rich text | Tiptap | FAQ/script editor |
| Charts | Recharts/Tremor | Analytics |

## Backend
| Layer | Choice | Reason |
|---|---|---|
| API | NestJS + TypeScript | Structured SaaS backend |
| DB | PostgreSQL | Tenants, agents, billing, audit |
| ORM | Prisma or Drizzle | Type-safe database access |
| Cache | Redis | Rate limits, sessions, queues |
| Jobs | BullMQ initially | Simple background jobs |
| Workflows | Temporal later | Durable workflows/campaigns |
| Analytics | ClickHouse later | High-volume call events |
| Files | S3/R2 | Recordings, uploads, exports |
| Billing | Stripe | Subscription + usage |
| Auth | Clerk/Auth0/WorkOS | Teams/orgs/SSO path |

## Voice Runtime
MVP: Mock provider → Vapi/Retell. Advanced: OpenAI Realtime + LiveKit + Twilio/Telnyx SIP.

## Deployment
MVP: Vercel + managed Postgres + Upstash + R2 + provider APIs.
Production: AWS ECS/Fargate or Kubernetes + RDS + ElastiCache + S3 + ClickHouse Cloud + Temporal Cloud.
