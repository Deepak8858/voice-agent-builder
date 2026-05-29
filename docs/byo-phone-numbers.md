# BYO Phone Numbers

VoiceForge supports BYO phone numbers through the dashboard at `Dashboard -> Phone Numbers`.

Supported providers:

- Twilio: automatic credential validation, number sync, import, webhook routing to LiveKit SIP.
- Vobiz / Vobiz.ai: automatic credential validation and number inventory where API access is available, plus manual SIP setup.

Every phone number row is scoped by `workspace_id` and `organization_id`. Provider credentials are encrypted with `ENCRYPTION_KEY`, and critical management actions create audit logs.

## Tables

- `telephony_provider_connections`: encrypted provider credentials and connection status.
- `telephony_phone_numbers`: imported/manual phone numbers and agent assignment.
- `livekit_telephony_configs`: LiveKit trunk IDs, dispatch rule IDs, room prefixes, and SIP host.
- `telephony_webhook_events`: idempotent provider/LiveKit webhook capture.

## API Shape

Management routes are workspace-scoped:

```txt
POST /api/v1/workspaces/:workspaceId/telephony/connections
POST /api/v1/workspaces/:workspaceId/telephony/connections/:id/sync-numbers
POST /api/v1/workspaces/:workspaceId/telephony/phone-numbers/import
POST /api/v1/workspaces/:workspaceId/telephony/phone-numbers/manual
POST /api/v1/workspaces/:workspaceId/telephony/phone-numbers/:id/assign-agent
POST /api/v1/workspaces/:workspaceId/telephony/phone-numbers/:id/configure-livekit
POST /api/v1/workspaces/:workspaceId/telephony/outbound-calls
```

Webhook routes are public and authenticate with provider signatures/secrets where available:

```txt
POST /api/v1/telephony/twilio/voice/:phoneNumberId
POST /api/v1/telephony/twilio/status/:phoneNumberId
POST /api/v1/telephony/vobiz/status/:phoneNumberId
POST /api/v1/livekit/webhooks
```
