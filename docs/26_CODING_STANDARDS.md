# 26 — Coding Standards

## TypeScript
Use strict mode, avoid `any`, share types/schemas in `packages/shared`, use Zod for runtime validation.

## Backend
Controllers handle HTTP. Services hold business logic. Guards enforce workspace access. DTOs validate inputs. Mutations create audit logs. Provider integrations use adapters.

## Frontend
Use shadcn/ui components. Use TanStack Query for API state. Use Zustand for local builder state. Use React Hook Form + Zod for forms. Every page needs loading, empty, and error states.

## Database
UUID primary keys, snake_case columns, workspace_id on tenant data, created_at/updated_at timestamps, migrations only.

## API
Consistent response format, structured errors, pagination on lists, idempotency for webhooks.

## Testing
Required tests: Agent Spec validation, compliance engine, workspace authorization, tool execution, billing usage, webhook idempotency.
