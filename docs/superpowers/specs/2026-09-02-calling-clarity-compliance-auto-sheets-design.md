# Calling clarity, campaign-level compliance, and automatic Google Sheets per agent

Date: 2026-09-02. Status: approved by the product owner in chat ("go"); implemented as four PRs in order.

## Why

Three reports from live use on 2026-09-02, all traced in production:

1. **"The agent is not calling +919454348234."** Five campaign dials left the platform correctly (compliance passed, LiveKit dialed) and the carrier rejected every INVITE while still dialing. The line was the Twilio number +12543235124, whose Twilio account is a **trial**; the warm-transfer dial on the same trunk returned the explicit reason `sip status: 400: 32100 Trial accounts can only call verified caller IDs`. The dashboard showed those calls as `no_answer`, `declined` or even `completed` with no carrier reason, and every LiveKit webhook was stored three times (277 rows for 93 distinct event ids in three days).
2. **"The agent cannot give the human's number."** The handoff target is never placed in the agent's instructions.
3. **"Compliance is impossible for a list of 100 numbers, and orders are not saved anywhere."** Agents default to `consent_required_for_outbound: true`; a dial is blocked unless the number already has a contact with a consent record, and the campaign screen only asks for two checkboxes and creates nothing. Sheets writing depends on an operator-configured `append_sheet_row` tool with a pasted spreadsheet id, positional `values`, and a schema that rejected `null` cells.

## Decisions (locked)

- The Twilio trial restriction is the customer's to resolve (upgrade, verify numbers, or use another line). The product must **say so** instead of showing `no_answer`.
- DNC list, caller opt-out and the blocked-purpose list stay **hard blocks**. Consent becomes satisfiable by an **attestation made once per campaign (or per ad-hoc call)** that covers every contact in it; the platform writes the consent records in bulk. Nothing is done per number.
- Google: one spreadsheet **per published agent**, created once, named after the agent, in the connected account's Drive. Column headings are the agent's `required_fields` keys, verbatim. Headers are append-only across republishes. Calendar reminders go to the connected account's **primary** calendar (per-agent calendars need the broader `calendar` scope and a reconnect; deferred).
- Tool calls must not slow the conversation: the runtime's implicit tools return immediately; the Google write happens asynchronously with retry on the API side.

## PR A — Calling clarity

- `buildVoiceForgeInstructions`: when handoff has a target phone, tell the model to read that number out, digit by digit, if the caller asks for it.
- LiveKit webhook: a `participant_left` for a SIP leg stores `metadata.sip_disconnect_reason` and `metadata.sip_last_status` on the call. On any terminal event, a call whose `call_usages.connected_at` is null is filed as `failed` with the reason-mapped outcome (`declined`, `no_answer`, `provider_dispatch_failed`, `agent_connect_failed`) even if an agent join had moved it to `in_progress`. Call detail shows a **Carrier reason** row.
- LiveKit webhook dedupe: the `telephony_webhook_events (provider, event_id)` unique index already exists; a duplicate insert now short-circuits processing instead of being swallowed.
- Twilio trial detection: `validateCredentials` returns the account `type`; it is stored as `metadata.account_type` on the connection (refreshed on every number sync) and returned as `account_type` in the connection DTO. The phone-numbers page shows a banner for `Trial` explaining the verified-caller restriction.

## PR B — Compliance set on the campaign

- `CreateOutboundCampaignDto.compliance`: `{ consent_attested: true, consent_type: 'outbound_transactional' | 'outbound_marketing', consent_source: string (free text, e.g. "signed order form 2026-08"), call_window?: { timezone, start_hour, end_hour } }`. On create, the service upserts a `Contact` per campaign contact and a `ConsentRecord` (type from the block, `source: 'campaign_attestation'`, evidence = actor id + campaign id + source text) in one transaction. The existing per-call `ComplianceService.check` then passes on consent for every contact, and DNC/opt-out still block individually.
- `StartTelephonyOutboundCallDto.consent_attested?: { consent_type, source }` does the same for a single ad-hoc dial.
- Campaign UI: the two checkboxes become the compliance block (consent type select, source text, optional call window); the copy explains that the attestation covers the whole list.
- `ComplianceBlockedError` is rendered with its reasons in the campaign and call UIs (today it is an opaque 422).

## PR C — Automatic Google Sheet per agent

- New table `agent_google_resources` (`agent_id` unique, `workspace_id`, `spreadsheet_id`, `spreadsheet_url`, `sheet_title` = "Calls", `columns` json `[{key, header}]`, `header_synced_at`, `status`, timestamps).
- `AgentSheetService.ensureForPublish(agent, spec)` runs inside `AgentsService.publish` after spec validation: when the workspace Google connection is `connected` with the `spreadsheets` scope, create the spreadsheet once (title = agent name), write the header row `Call time | Caller number | Call ID | Outcome | <required_fields keys…>`, and on later publishes append headers for new keys only. Failures are logged and surfaced as a publish warning, never a publish failure.
- Runtime: implicit tool `save_caller_details` registered when the agent has a sheet; parameters are one optional string per required field key (descriptions from the spec). The tool posts `{callId, agentId, fields}` to `POST /internal/runtime/caller-details` and returns `{saved: true}` **without waiting for Google**; the API merges the fields into `calls.metadata.caller_details`, enqueues a BullMQ `sheet-sync` job keyed by call id, and the worker appends the row on first write (storing the row number in `calls.metadata.sheet_row`) and updates it on later writes. Jobs for one call are serialized by the job id. Call end fills the Outcome cell.
- Instruction: "As soon as the caller gives any of these details, call save_caller_details with what you have; call it again as more arrive. Do not wait for all fields."
- Agent page shows the sheet link. The `append_sheet_row` preset remains for explicit flows.

## PR D — Calendar reminders

- Implicit tool `schedule_reminder(when_iso, title, notes)` when the workspace has the `calendar.events` scope; creates an event on `primary` titled `<agent name>: <title>` with caller number and call id in the description; idempotent per call + when. Reuses `GoogleCalendarExecutor.create_event` through the same async path as PR C.

## Out of scope

- Per-agent calendars (needs `calendar` scope + reconnect). Reading the SIP status code on dial (would require `waitUntilAnswered: true` on the API dial). VoiceLink outbound failure (separate investigation in progress).
