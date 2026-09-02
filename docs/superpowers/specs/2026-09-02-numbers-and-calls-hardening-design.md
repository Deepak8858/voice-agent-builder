# Numbers & Calls Hardening (current LiveKit stack) — Design

**Date:** 2026-09-02 · **Status:** approved by goal directive (user: "first make sure user can add
numbers and create calls, this is more important — from their Twilio account, or other providers")
· **Relation to Voice V2:** this is the bridge that makes calling work *now* on the LiveKit stack.
It keeps the UI shape V2 §5.3 already decided (two-button phone-numbers page, ElevenLabs-style
import) so nothing here is thrown away when V2 lands; the LiveKit-specific plumbing behind it is
what V2 deletes.

## 1. Problem (verified 2026-09-02 on production)

1. **Inbound calls can only be admitted through the Twilio TwiML webhook.** `handleTwilioVoice` is
   the sole `ensureInboundCall` + `admitInboundCall` path, and the agent's `resolveCallAttribution`
   requires the SIP attribute `sip.twilio.callSid`. An inbound call on a plain SIP number (the
   user's VoiceLink `+917969007408`) or a Vobiz number reaches the agent and throws
   `inbound SIP participant is missing sip.twilio.callSid` — the caller hears silence.
2. **The Twilio bridge cannot route.** The TwiML dials `sip:<LIVEKIT_SIP_HOST>` with no user part;
   LiveKit matches inbound trunks on the called number, so the INVITE matches nothing.
3. **Twilio outbound is impossible.** `providerOutboundAddress('twilio')` reads `TWILIO_SIP_DOMAIN`,
   which is not set in production and is the wrong model anyway (a platform-wide Twilio SIP domain
   instead of the customer's own trunk).
4. **The UI is three panels and a dead end.** "Manual SIP" always yields `pending_verification`,
   which `assign-agent` rejects. Configure is a separate button after assign. `manual_required`
   instructions from `configureLiveKit` are discarded by the page. Status badges are generic.
5. **The carrier leg is silent for VoiceLink.** LiveKit's INVITEs get no response from
   `sip.voicelink.co.in`. *Corrected 2026-09-02:* this was **not** an IP allow-list. The SBC
   (OpenSIPS) listens only on port **3300** and drops 5060; LiveKit dials 5060 unless the trunk
   address carries a port, and the import validator rejected `host:port`. Fixed by accepting
   `host:port` and setting the trunk to `sip.voicelink.co.in:3300`. The UI never told the customer
   what to give the carrier, nor asked for the port.
6. Noticed UI defects: campaign cards show "No agent"; campaign "In Progress" never decrements
   after failures; an unanswered outbound ends `completed` with `outcome=null`; wizard labels are not
   bound to inputs; magic-link login bounces via `/onboarding`.

## 2. Goals

- A customer connects a Twilio number with **Account SID + Auth Token, pick numbers, done** — we
  create the Elastic SIP trunk in their account (ElevenLabs-grade). Inbound **and** outbound work.
- A customer connects any SIP-trunk number with 4 fields and gets **one card telling their carrier
  exactly what to configure** (the SIP URI, transport, auth, and LiveKit's IP allow-list pointer).
- Inbound works for **every** provider (admission is provider-agnostic).
- Assigning an agent is the last step; LiveKit configuration happens automatically.
- Fix the six noticed defects.

## 3. Non-goals

Buying platform numbers (V2 §5.2), Vobiz automation beyond what exists, SMS, LiveKit IP
allow-listing on inbound trunks (documented, not enforced), replacing LiveKit (V2).

## 4. Design

### 4.1 Provider-agnostic inbound admission

**API** — new `POST /api/v1/internal/runtime/inbound/admit` (`@InternalOnly()`, `x-internal-key`,
same module as `runtime-usage.controller.ts`). Body: `{ organizationId, workspaceId, phoneNumberId,
agentId, provider, providerCallId, fromNumber?, toNumber?, roomName?, participantIdentity? }`
(validated with zod; tenant fields must match the phone-number row or 404). Behaviour:
`ensureInboundCall` (idempotent on `(provider, providerCallId)`) → `admitInboundCall` (existing,
idempotent) → on refusal mark the call `failed / billing_denied` and return
`{ admitted: false, reason }`; else `{ admitted: true, callId }`.

**Teardown has exactly one owner: the API.** Every refusing path (tenant mismatch, number not
assigned to this agent, admission denied) removes the SIP participant first, falling back to
deleting the room if the removal fails; only then does it answer. A refusal the API could not
enforce (no `roomName`/`participantIdentity` in the request, or LiveKit rejected both calls) comes
back with `_still_connected` appended to the reason and an error log, so a stuck carrier leg is
never mistaken for a clean refusal. The runtime therefore never speaks to a refused caller — by the
time it reads the answer the leg is already gone — it only stops the job.

**Agent** — `resolveCallAttribution`: providerCallId = `sip.twilio.callSid` ?? `sip.callID`
(LiveKit always sets `sip.callID`). If no matching admitted call row exists (the SIP-delivered
case), call the admit endpoint with the dispatch metadata, the participant's identity, and its
`sip.phoneNumber` / `sip.trunkPhoneNumber`. Refused → log the reason and `ctx.shutdown()` without
metering; the carrier leg is already down (see the teardown owner above), so there is nobody left
to speak a refusal line to.
The Twilio TwiML path keeps working for numbers not yet migrated to a trunk, because
`ensureInboundCall` keys the same `(provider, providerCallId)` the webhook wrote.

### 4.2 Twilio: Elastic SIP trunk automation

**On `POST connections` (twilio)**, after credential validation, `ensureTwilioTrunk`:
1. Trunking API `GET /v1/Trunks` → reuse the trunk whose `FriendlyName === 'VoiceForge'`; else
   `POST /v1/Trunks {FriendlyName:'VoiceForge', DomainName:'vf-<12 hex>.pstn.twilio.com'}`.
2. `POST /v1/Trunks/{sid}/OriginationUrls {SipUrl:'sip:<LIVEKIT_SIP_HOST>;transport=tcp',
   Priority:1, Weight:1, Enabled:true, FriendlyName:'VoiceForge LiveKit'}` (skip if present).
3. Voice API `POST /2010-04-01/Accounts/{sid}/SIP/CredentialLists.json {FriendlyName:'VoiceForge'}`
   and `.../Credentials.json {Username:'vf_<8 hex>', Password:<24-char mixed>}`; Trunking
   `POST /v1/Trunks/{sid}/CredentialLists {CredentialListSid}`.
4. Persist in `telephony_provider_connections.metadata`: `{ twilioTrunk: { trunkSid, domainName,
   originationUrlSid, credentialListSid, username, passwordEncrypted } }` (password via
   `EncryptionService.encryptJson`).
Idempotent: every step looks before it creates. Any Twilio failure → 502 `TELEPHONY_PROVIDER_ERROR`
with Twilio's message verbatim; the connection row is still created (status `connected`,
`metadata.twilioTrunk` absent) so the user can retry via "Reconfigure".

**On `configureLiveKit` for a twilio number** (auto-run by assign-agent, §4.4):
- `configureInboundRouting` becomes: Trunking `POST /v1/Trunks/{trunkSid}/PhoneNumbers
  {PhoneNumberSid}` (409 = already associated → ok). Associating moves the number off Programmable
  Voice, so the TwiML webhook is no longer in the path.
- LiveKit inbound trunk: numbers `[E164]`, no auth (Twilio origination does not digest-auth;
  the trunk's `numbers` filter is the guard, as today).
- LiveKit outbound trunk: address `metadata.twilioTrunk.domainName`, transport TCP,
  `authUsername/Password` from the connection metadata. `TWILIO_SIP_DOMAIN` is deleted.
- Twilio imports default `outboundEnabled: true`.
- `removeRouting` (delete/disconnect): Trunking `DELETE /v1/Trunks/{trunkSid}/PhoneNumbers/{sid}`.

### 4.3 SIP-trunk numbers: the carrier card

`POST phone-numbers/sip` response and the number card gain `carrier_setup`:
```text
Inbound  → point your carrier at:  sip:+<E164>@<LIVEKIT_SIP_HOST>;transport=tcp
           auth: digest (username shown) | none — ask the carrier to allow LiveKit's SIP IPs
           (link: LiveKit Cloud → Settings → Static IPs)
Outbound → we send INVITEs to <sip_trunk_domain> from +<E164> with the same credentials;
           the carrier must accept LiveKit's SIP IPs and permit +<E164> as caller ID.
```
Rendered as a copyable block. The same block shows `manual_required.manualInstructions` for
Twilio/Vobiz when their API call failed.

### 4.4 Assign-agent is the last step

`assignAgent` auto-runs `configureLiveKit` for **every** provider when the number is verified and an
agent is set (today: sip only). The page keeps only a "Reconfigure" action. `pending_verification`
rows show a "Verify by importing from your provider connection" hint instead of a dead button.

### 4.5 Phone-numbers page → two flows

"Connect Twilio numbers" (provider select stays for Vobiz) and "Connect a SIP trunk number". The
"Manual SIP" panel is removed (its only non-dead use, Vobiz trunk-only rows, is already covered by
the connection flow's E.164 override). `StatusBadge` gains telephony labels: `livekit_configured` →
"Ready", `verified` → "Needs agent", `pending_verification` → "Pending verification", `error` → "Error".

### 4.6 Noticed defects

- Campaign list: resolve agent name from `agent_id` (join in `GET campaigns` DTO or client map).
- Campaign stats: decrement `in_progress` when a call finalizes failed/completed (finalization hook
  in `runtime-usage.service` / LiveKit `participant_left` handler → `campaigns.incrementStat(…,'failed'|'completed')`).
- Unanswered outbound (`disconnectReason=USER_UNAVAILABLE`, never connected) → `status: failed,
  outcome: no_answer` (LiveKit webhook mapping, not `completed`).
- Wizard labels: `htmlFor`/`id` pairs on the schedule step inputs.
- Magic-link/OAuth callback: after `verifyOtp`/`exchangeCodeForSession`, redirect to `next` when the
  user already has a workspace (query `memberships` via admin client) instead of `/onboarding`.

## 5. Data / migrations

None. `telephony_provider_connections.metadata` (Json, nullable) carries the Twilio trunk info.

## 6. Error handling

Twilio API errors surface verbatim (status + Twilio `message`) as `TELEPHONY_PROVIDER_ERROR` 502.
Admission refusal for inbound is spoken, not silent. All LiveKit resource creation keeps the
existing compensate-on-partial-failure pattern (PR #150).

## 7. Testing

- Unit: `ensureTwilioTrunk` idempotency against a fetch mock (existing `fetchImpl` seam); admit
  endpoint (new/refused/duplicate); attribution fallback to `sip.callID`; webhook `USER_UNAVAILABLE`
  → `no_answer`; campaign stat decrement; StatusBadge labels.
- Live E2E (prod, user's own Twilio account `+12543235124` and mobile): connect → import →
  assign → outbound campaign call rings the mobile and the agent speaks; inbound: Twilio REST
  `Calls.create(to: +12543235124)` from the same account → agent answers.

## 8. Rollout

Four PRs, each through the CodeRabbit gate ([[voiceforge-merge-deploy-protocol]]):
A) inbound admission (API + agent); B) Twilio trunk automation + two-flow UI + status labels +
noticed defects; C) dark mode + wiring quick fixes (recording playback, campaign error toasts,
empty-workspace guard, pause try/catch); D) research doc (ElevenLabs STT/TTS + low-latency plan).
