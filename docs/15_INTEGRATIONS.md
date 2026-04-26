# 15 — Integrations

## MVP Integrations
Google Calendar, Google Sheets, Webhooks, Zapier/Make/n8n through webhook, Stripe, Vapi/Retell.

## Tool Registry
Every integration action becomes a controlled tool.

```json
{
  "name": "google_calendar.book_slot",
  "description": "Book an appointment.",
  "input_schema": {
    "type": "object",
    "properties": {
      "start_time": { "type": "string" },
      "end_time": { "type": "string" },
      "attendee_name": { "type": "string" },
      "attendee_phone": { "type": "string" }
    },
    "required": ["start_time", "end_time", "attendee_name"]
  },
  "requires_confirmation": true
}
```

## Tool Execution Rules
Validate input schema, check workspace permission, check agent permission, check integration status, execute provider API, log input/output, return safe result to agent, never expose secrets.

## Webhook Payload Example
```json
{
  "event": "lead_qualified",
  "workspace_id": "uuid",
  "agent_id": "uuid",
  "call_id": "uuid",
  "fields": {}
}
```
