# HIPAA + SOC2 Technical Compliance

## Data Classification

| Type | Examples | Controls |
|------|----------|----------|
| PHI | Call audio, transcripts, phone numbers | Encryption at rest + transit, access control, audit log |
| PII | User email, name | Encryption at rest, access control |
| Non-sensitive | Agent config, public agent specs | Standard access controls |

## Technical Controls

### Encryption
- **At rest:** AES-256 via Supabase's managed-Postgres storage layer, plus
  field-level AES-256-GCM envelope encryption for sensitive columns
  (integration credentials, OAuth tokens).
- **Key rotation:** envelopes carry a key id (`kid`); `ENCRYPTION_KEYS`
  accepts a keyring so new writes can move to a fresh key. Ciphertexts
  written before a rotation stay on their original key until a re-encryption
  walk (not yet built) migrates them — a rotation alone does not retire the
  old key.
- **In transit:** TLS 1.2+ mandatory (HSTS configured in main.ts)
- **Required in production:** ENCRYPTION_KEY boot check enforces encryption key presence

### Access Controls
- Workspace-scoped RBAC (owner/admin/editor/viewer)
- InternalAuthGuard for admin endpoints
- WorkspaceGuard for customer-facing endpoints

### Audit Logging
- Every significant action logged to AuditLog table
- Immutable (no update/delete operations on audit records)
- Export available in CSV/JSON/signed URL formats

### Retention & Disposal
- expires_at column on Call records — auto-set on insert
- Daily sweep (BullMQ worker, 03:30 UTC, batches of 5000) deletes expired
  calls and ages out raw telephony webhook payloads; gated behind
  `RETENTION_SWEEP_ENABLED`
- Per-workspace configurable (30-3650 days); shortening retention re-stamps
  existing calls, which can make older recordings immediately sweepable

### Data Erasure (GDPR)
- Contact erasure: cascades to calls, analytics, evaluations
- Organization deletion: cascades workspace data, releases carrier phone
  numbers, and cancels any live subscription — but billing-ledger and
  provider-cost rows are `ON DELETE RESTRICT`, so an organization with
  payment or call history cannot currently be hard-deleted
  (anonymize-vs-delete is an open product decision)
- User deletion: removes memberships and the user record; blocked for users
  who own an organization (the same RESTRICT posture)
- Erasure audit rows are written inside the same transaction as the deletes,
  so a rolled-back erasure never leaves a false "erased" attestation

## Infrastructure

- Primary DB: Supabase managed Postgres (AWS ap-northeast-1, Tokyo)
- Backups: Supabase automated daily + point-in-time recovery
- Voice transport: LiveKit + Twilio (encryption handled by provider)
- Voice runtimes: OpenAI Realtime (paid plans) and the in-house pipeline on Azure
  AI (Azure Speech STT/TTS + Azure OpenAI)
- No PHI leaves the platform except to subprocessors listed in DPA

## BAAs and provider HIPAA prerequisites

A generic DPA does **not** establish HIPAA coverage. Each provider below has its
own prerequisites, and PHI must not be routed through a provider until every
prerequisite for that provider is satisfied and recorded.

### OpenAI (Realtime + other API services)
- Executed BAA that lists **API Services** as an eligible service. Request via
  `baa@openai.com`; approval is case-by-case.
- **Modified Retention** provisioned on the specific organization ID and project
  that will carry PHI. HIPAA eligibility for the API — including the Realtime
  endpoint — is contingent on this provisioning.
- The generic DPA (https://openai.com/policies/data-processing-addendum) is not a
  substitute for either of the above.

### Twilio (PSTN / SIP transport)
- Account on **Security Edition or Enterprise Edition**; a BAA cannot be signed
  on lower editions.
- Executed BAA (Business Associate Addendum) covering the specific projects and
  subaccounts that process PHI.
- PHI workflows restricted to products on Twilio's HIPAA Eligible Services list;
  products not on that list must not touch PHI.
- Architecture must follow Twilio's "Architecting for HIPAA" guidance —
  compliance is a shared responsibility and the BAA alone does not confer it.

### Microsoft Azure (Speech STT/TTS + Azure OpenAI chat — the `standard` pipeline)
- HIPAA BAA under the Microsoft Products and Services Data Protection Addendum:
  https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA
- Confirm every Azure service in the pipeline is in scope for that BAA before
  routing PHI to it.

### Other subprocessors
- LiveKit: https://livekit.io/legal/dpa — DPA only; a BAA is required before PHI
  transits LiveKit media.
- Supabase: https://supabase.com/dpa — DPA only; a BAA is required before PHI is
  persisted.

### Enforcement status (open gap)
These prerequisites are currently **documented, not enforced**. There is no
runtime gate that blocks PHI routing to a provider whose prerequisites are
unverified: the compliance engine covers DNC, consent, quiet hours, and opt-out,
and the only HIPAA-related boot check is the `ENCRYPTION_KEY` presence check in
`apps/api/src/main.ts:15-19`. Provider-level PHI admission control (a per-provider
HIPAA-eligibility record, a workspace PHI flag, and a routing gate in
`PipelineRouterService` / the telephony adapters) is tracked as separate work and
is not part of this change. Until it exists, PHI-bearing deployments must be
verified manually against this section.
