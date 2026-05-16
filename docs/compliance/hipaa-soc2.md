# HIPAA + SOC2 Technical Compliance

## Data Classification

| Type | Examples | Controls |
|------|----------|----------|
| PHI | Call audio, transcripts, phone numbers | Encryption at rest + transit, access control, audit log |
| PII | User email, name | Encryption at rest, access control |
| Non-sensitive | Agent config, public agent specs | Standard access controls |

## Technical Controls

### Encryption
- **At rest:** AES-256 via Supabase storage layer + ENCRYPTION_KEY for sensitive fields
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
- Daily pg_cron sweep deletes expired records (batch of 5000)
- Per-workspace configurable (30-3650 days)

### Data Erasure (GDPR)
- Contact erasure: cascades to calls, analytics, evaluations
- Organization deletion: cascades all workspace data
- User deletion: removes memberships and user record
- All erasures logged before execution

## Infrastructure

- Primary DB: Supabase (us-east-1)
- Backups: Supabase automated daily + point-in-time recovery
- Voice processing: Vapi/Twilio (encryption handled by provider)
- No PHI leaves the platform except to subprocessors listed in DPA

## BAAs

- Vapi: https://vapi.ai/dpa
- Twilio: https://www.twilio.com/legal/bba
- Supabase: https://supabase.com/dpa