# Phase 6 — Compliance Engine
## Problem
Phases 0–5 are substantively built (monorepo, agent builder, knowledge with embeddings, voice runtime + browser test, inbound deployment + post-call evaluation, integrations/tools). The next milestone in `docs/20_IMPLEMENTATION_ROADMAP.md` is **Phase 6 — Compliance**: contacts, consent, DNC/DND, opt-out, pre-call compliance check, audit logs.
## Current state
* Prisma schema has agents, knowledge, calls, evaluations, tools — but **no** contacts/consent/DNC/compliance tables.
* `apps/api/src/calls/calls.service.ts` `startOutboundCall` enforces only `agent.status === 'published'`. There is no compliance gate yet.
* `AgentSpecSchema.compliance` already drives the agent-level intent (consent_required_for_outbound, AI disclosure, recording notice, allowed_call_window).
* `apps/api/src/common/errors.ts` does **not** yet export `COMPLIANCE_BLOCKED`, but `packages/shared/src/schemas/api.ts` already lists the code, so wiring is straightforward.
## Proposed changes (backend-only slice; frontend stays coming-soon)
### 1. Prisma schema (`apps/api/prisma/schema.prisma`)
Add four models, all `@@map`-ed, all workspace-scoped:
* `Contact` (id, workspaceId, phone, email?, fullName?, metadata, optOut, createdAt, updatedAt) — uniq on `(workspaceId, phone)`.
* `ConsentRecord` (id, workspaceId, contactId, consentType, source, proofUrl?, consentedAt, expiresAt?, revokedAt?, metadata, createdAt). `consent_type` enum-as-string: `outbound_marketing | outbound_transactional | recording | ai_disclosure`.
* `DncEntry` (id, workspaceId, phone, source, reason?, createdAt). Uniq on `(workspaceId, phone)`.
* `ComplianceCheck` (id, workspaceId, agentId, contactId?, callId?, direction, status: `passed|blocked`, reasons Json, metadata Json?, checkedAt). Indexed by `(workspaceId, checkedAt)` and `(agentId, checkedAt)`.
* Add `contactId` (nullable) to `Call`.
* Wire reverse relations on `Workspace`, `Agent`, `Call`.
### 2. Shared schemas (`packages/shared/src/schemas/compliance.ts`)
New file exporting:
* `ConsentTypeSchema`, `ComplianceStatusSchema`, `ComplianceReasonCodeSchema` (e.g. `missing_consent`, `opted_out`, `dnc_listed`, `outside_call_window`, `agent_not_published`, `unsupported_purpose`, `missing_ai_disclosure`, `missing_recording_notice`).
* DTOs: `CreateContactDtoSchema`, `UpdateContactDtoSchema`, `GrantConsentDtoSchema`, `RevokeConsentDtoSchema`, `AddDncDtoSchema`, `ComplianceCheckRequestDtoSchema`.
* Result types: `ContactSummary`, `ContactDetail`, `ConsentRecord`, `DncEntry`, `ComplianceCheckResult`, `ComplianceReason`.
* Re-export from `packages/shared/src/index.ts`.
### 3. Errors (`apps/api/src/common/errors.ts`)
Add `ContactNotFoundError`, `ConsentNotFoundError`, `ComplianceBlockedError` (HTTP 422 with `code: COMPLIANCE_BLOCKED` + `details: { reasons }`).
### 4. NestJS module `apps/api/src/compliance/`
* `compliance.module.ts` — exports `ComplianceService`.
* `compliance.service.ts`:
    * `upsertContact`, `listContacts`, `getContact`, `updateContact`, `optOutContact`.
    * `grantConsent`, `revokeConsent`, `listConsentForContact`.
    * `addDnc`, `removeDnc`, `listDnc`, `isDnc(phone)`.
    * `check({ workspaceId, agentId, direction, toNumber, contactId? })` returning `ComplianceCheckResult`. Loads agent + latest published version → reads `spec.compliance` → runs the rule chain documented in `docs/11_COMPLIANCE_ENGINE.md` and persists a `ComplianceCheck` row. Inbound check is a degenerate pass with `ai_disclosure_required` informational reason.
    * Audits every mutation.
* `contacts.controller.ts` (workspace-guarded) → `GET|POST /workspaces/:ws/contacts`, `GET|PATCH /workspaces/:ws/contacts/:id`, `POST /workspaces/:ws/contacts/:id/consent`, `POST /workspaces/:ws/contacts/:id/opt-out`.
* `compliance.controller.ts` (workspace-guarded) → `POST /workspaces/:ws/compliance/check`, `GET|POST /workspaces/:ws/compliance/dnc`, `DELETE /workspaces/:ws/compliance/dnc/:phone`.
### 5. Wire into `CallsService.startOutboundCall`
Before calling `this.voice.startOutboundCall(...)`:
1. Resolve / upsert `Contact` by phone.
2. Run `compliance.check({ direction: 'outbound', ... })`.
3. If `status === 'blocked'`, throw `ComplianceBlockedError({ reasons })` and write an audit `call.outbound.blocked`.
4. Persist `compliance_check_id` + `contact_id` on the resulting `Call` row.
### 6. AppModule wiring
Import `ComplianceModule` in `app.module.ts`, list it after `KnowledgeModule` and before `CallsModule` (so `CallsModule` can inject `ComplianceService`).
### 7. Verification
* `npm run db:generate -w @voiceforge/api` to refresh Prisma Client types.
* `npm run typecheck` across all 4 workspaces.
* DB push & seed deferred (user env).
* Tests deferred per user direction.
## Out of scope (for this slice)
* `apps/web` UI surfaces (will remain coming-soon).
* Twilio DNC API sync (`source: 'twilio'`).
* Local-time-of-day check using contact timezone (only agent `allowed_call_window` honored for now).
