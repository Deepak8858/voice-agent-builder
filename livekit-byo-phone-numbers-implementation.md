# LiveKit BYO Phone Numbers Implementation Plan

This document is the implementation specification for adding **Bring Your Own Phone Number** support to `voice-agent-builder` using:

- **LiveKit** as the realtime audio, SIP, room, and agent runtime layer
- **Twilio** as a supported BYO phone number provider
- **Vobiz / Vobiz.ai** as a supported BYO phone number provider

The goal is to let users connect phone numbers they already own in Twilio or Vobiz, assign those numbers to AI voice agents, and route inbound/outbound calls through LiveKit.

---

## 1. Product Goal

Users should be able to:

1. Open the app dashboard.
2. Go to **Phone Numbers** or **Telephony**.
3. Click **Connect Number**.
4. Choose a provider:
   - Twilio
   - Vobiz / Vobiz.ai
5. Connect provider credentials or use manual setup.
6. Import or manually add phone numbers.
7. Assign each phone number to a voice agent.
8. Configure LiveKit SIP routing.
9. Route inbound calls to the correct AI voice agent.
10. Start outbound calls where supported.
11. View call logs, usage, status, transcripts, and errors.

This must be a real backend implementation, not fake UI only.

---

## 2. Repository Audit First

Before coding, audit the repository.

Check:

- Monorepo structure
- Frontend framework
- Backend framework
- Auth system
- Database/ORM
- Existing agent model
- Existing call model
- Existing billing/plan logic
- Existing webhook routes
- Existing realtime/voice code
- Existing Twilio code
- Existing Vobiz code
- Existing LiveKit code
- Existing environment variable patterns
- Existing UI/navigation patterns

Search for:

```text
livekit
LIVEKIT
@livekit
twilio
TWILIO
vobiz
VOBIZ
sip
trunk
phone
number
telephony
call
voice
webhook
inbound
outbound
room
participant
agent runtime
```

Do not begin implementation until an audit summary is written.

Audit deliverables:

1. Current stack
2. Existing telephony support
3. Existing realtime support
4. Existing LiveKit support
5. Existing provider support
6. Missing pieces
7. Risks
8. Implementation plan

---

## 3. Target Architecture

```text
User-owned phone number
        ↓
Twilio or Vobiz
        ↓
Provider routing / SIP / webhook / TwiML
        ↓
LiveKit SIP
        ↓
LiveKit inbound trunk
        ↓
LiveKit dispatch rule
        ↓
LiveKit room
        ↓
LiveKit AI agent runtime
        ↓
Voice agent configuration from app database
        ↓
Call logs, transcripts, usage, billing limits
```

### Responsibility split

The app owns:

- Users
- Auth
- Voice agents
- Provider connections
- Phone number ownership records
- Phone number to agent assignment
- LiveKit room/trunk/dispatch configuration
- Call logs
- Usage tracking
- Billing limits
- UI/UX
- Security and encryption

LiveKit owns:

- Realtime rooms
- SIP ingress/egress
- Audio routing
- Participant lifecycle
- AI agent room participation

Twilio and Vobiz own:

- Phone numbers
- PSTN/SIP routing
- Provider-side call events
- Provider-specific number capabilities

---

## 4. Packages to Add

Verify latest package names and versions before installing.

### Backend

Likely package:

```bash
npm install livekit-server-sdk -w @voiceforge/api
```

Add other official LiveKit SIP/server packages only if the current LiveKit SDK requires separate packages.

### Frontend

Likely packages:

```bash
npm install livekit-client @livekit/components-react -w @voiceforge/web
```

Use frontend packages only for browser-based LiveKit test rooms. Do not expose LiveKit API secrets in the browser.

---

## 5. Environment Variables

Update `.env.example`.

```env
# App
APP_BASE_URL=https://your-domain.com
ENCRYPTION_KEY=replace-with-32-byte-secret

# LiveKit
LIVEKIT_URL=wss://your-livekit-project.livekit.cloud
LIVEKIT_API_KEY=replace-with-livekit-api-key
LIVEKIT_API_SECRET=replace-with-livekit-api-secret
LIVEKIT_SIP_HOST=replace-with-livekit-sip-host
LIVEKIT_WEBHOOK_SECRET=replace-with-livekit-webhook-secret
LIVEKIT_ROOM_PREFIX=call
LIVEKIT_AGENT_NAME_PREFIX=voiceforge-agent

# Optional platform-level Twilio fallback config
TWILIO_WEBHOOK_AUTH_TOKEN=
TWILIO_STATUS_CALLBACK_URL=

# Optional Vobiz fallback config
VOBIZ_WEBHOOK_SECRET=
```

Rules:

- `LIVEKIT_API_SECRET` must only be used on the backend.
- Provider secrets must only be used on the backend.
- Frontend may receive short-lived LiveKit room tokens only.
- Never commit real credentials.

---

## 6. Backend Module Structure

Suggested backend files:

```text
apps/api/src/livekit/livekit.module.ts
apps/api/src/livekit/livekit.service.ts
apps/api/src/livekit/livekit.controller.ts
apps/api/src/livekit/livekit-webhook.controller.ts
apps/api/src/livekit/livekit.types.ts

apps/api/src/telephony/telephony.module.ts
apps/api/src/telephony/telephony.service.ts
apps/api/src/telephony/telephony.controller.ts
apps/api/src/telephony/telephony-webhook.controller.ts

apps/api/src/telephony/providers/provider.types.ts
apps/api/src/telephony/providers/provider-registry.ts
apps/api/src/telephony/providers/twilio.provider.ts
apps/api/src/telephony/providers/vobiz.provider.ts

apps/api/src/security/encryption.service.ts
```

If the repo already has equivalent modules, extend the existing structure instead of duplicating concepts.

---

## 7. LiveKit Service

Create a LiveKit service that centralizes all LiveKit operations.

Suggested interface:

```ts
export interface LiveKitTelephonyService {
  createRoomForCall(params: CreateCallRoomParams): Promise<LiveKitRoomResult>;

  createAccessToken(params: {
    userId: string;
    roomName: string;
    identity: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;

  createInboundSipTrunk(params: {
    phoneNumberId: string;
    phoneNumberE164: string;
    provider: 'twilio' | 'vobiz';
    authUsername?: string;
    authPassword?: string;
  }): Promise<LiveKitSipTrunkResult>;

  createOutboundSipTrunk(params: {
    phoneNumberId: string;
    phoneNumberE164: string;
    provider: 'twilio' | 'vobiz';
  }): Promise<LiveKitSipTrunkResult>;

  createDispatchRule(params: {
    phoneNumberId: string;
    agentId: string;
    trunkId: string;
    roomPrefix: string;
    agentName: string;
    metadata?: Record<string, unknown>;
  }): Promise<LiveKitDispatchRuleResult>;

  deleteSipTrunk(trunkId: string): Promise<void>;
  deleteDispatchRule(dispatchRuleId: string): Promise<void>;

  createOutboundCall(params: {
    phoneNumberId: string;
    agentId: string;
    toNumber: string;
    fromNumber: string;
  }): Promise<LiveKitOutboundCallResult>;
}
```

Implementation rules:

- Use official LiveKit APIs/SDKs.
- Do not shell out to LiveKit CLI in production code unless no SDK/API path exists.
- Store LiveKit trunk IDs and dispatch rule IDs in the database.
- All LiveKit secrets stay backend-only.

---

## 8. Voice Agent Runtime

Create or extend a LiveKit-compatible voice agent runtime.

Suggested interface:

```ts
export interface VoiceAgentRuntime {
  provider: 'livekit';

  startAgentForRoom(params: {
    appAgentId: string;
    livekitRoomName: string;
    callId: string;
    userId: string;
    phoneNumberId?: string;
    direction: 'inbound' | 'outbound' | 'browser_test';
  }): Promise<void>;

  buildAgentInstructions(params: {
    appAgentId: string;
    callId: string;
  }): Promise<string>;

  stopAgentForRoom(params: {
    livekitRoomName: string;
    callId: string;
  }): Promise<void>;
}
```

Runtime requirements:

- Load agent configuration from the app database.
- Convert agent persona, prompt, voice, model, and tool settings into runtime settings.
- Support OpenAI Realtime or another voice pipeline if already used.
- Support transcript capture where possible.
- Save call summaries where possible.
- Save errors and debug logs.
- Join the correct LiveKit room for the assigned agent.

If a full worker service is needed, create:

```text
apps/agent-worker/
  package.json
  src/index.ts
  src/agent.ts
  src/config.ts
  src/tools.ts
  src/transcripts.ts
```

The worker should connect to LiveKit, receive room/job dispatches, load app agent config, and join rooms as the AI participant.

---

## 9. Provider Adapter Architecture

Implement Twilio and Vobiz through a common adapter system.

```ts
export type PhoneProvider = 'twilio' | 'vobiz';

export interface PhoneNumberProviderAdapter {
  provider: PhoneProvider;

  validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<ProviderValidationResult>;

  listPhoneNumbers(
    credentials: ProviderCredentials,
  ): Promise<ProviderPhoneNumber[]>;

  getPhoneNumber(
    credentials: ProviderCredentials,
    providerNumberId: string,
  ): Promise<ProviderPhoneNumber>;

  configureInboundRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    livekitSipUri: string;
    fallbackWebhookUrl: string;
    statusCallbackUrl: string;
  }): Promise<ProviderRoutingResult>;

  configureOutboundRouting?(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
    livekitOutboundTrunkId: string;
  }): Promise<ProviderRoutingResult>;

  removeRouting(params: {
    credentials: ProviderCredentials;
    phoneNumber: ConnectedPhoneNumber;
  }): Promise<void>;

  validateWebhookSignature?(params: ValidateWebhookParams): Promise<boolean>;
  normalizeInboundPayload?(payload: unknown): NormalizedInboundCall;
  normalizeStatusPayload?(payload: unknown): NormalizedCallStatus;
}
```

Rules:

- Provider-specific data must be normalized into internal models.
- Do not spread Twilio/Vobiz logic throughout controllers and UI.
- Provider credentials must be encrypted before saving.

---

## 10. Database Models

Inspect the existing Prisma/ORM schema first. Add models only if missing.

### TelephonyProviderConnection

```text
id
userId
provider: twilio | vobiz
displayName
providerAccountId
encryptedCredentials
credentialVersion
status: connected | invalid | error | disconnected
lastVerifiedAt
lastSyncAt
createdAt
updatedAt
```

### PhoneNumber

```text
id
userId
providerConnectionId
provider: twilio | vobiz
providerNumberId
phoneNumberE164
friendlyName
capabilitiesJson
status: pending_verification | verified | active | webhook_configured | livekit_configured | error | disconnected
assignedAgentId
inboundEnabled
outboundEnabled
lastSyncedAt
createdAt
updatedAt
```

### LiveKitTelephonyConfig

```text
id
userId
phoneNumberId
agentId
livekitRoomPrefix
livekitSipHost
inboundTrunkId
outboundTrunkId
dispatchRuleId
sipAuthUsernameEncrypted
sipAuthPasswordEncrypted
status: pending | configured | verified | error
createdAt
updatedAt
```

### Call

Use an existing call model if present. Otherwise add:

```text
id
userId
agentId
phoneNumberId
provider
livekitRoomName
livekitParticipantId
providerCallId
direction: inbound | outbound | browser_test
fromNumber
toNumber
status
startedAt
answeredAt
endedAt
durationSeconds
transcript
summary
recordingUrl
metadataJson
errorMessage
createdAt
updatedAt
```

### TelephonyWebhookEvent

```text
id
provider
eventId
eventType
phoneNumberId
callId
rawPayloadJson
signatureValid
processedAt
status
errorMessage
createdAt
```

### UsageRecord

```text
id
userId
callId
phoneNumberId
agentId
usageType: call_minute | connected_number | test_call
quantity
billingPeriodStart
billingPeriodEnd
createdAt
```

Migration rules:

- Follow the existing ORM/migration pattern.
- If using Prisma, create/update schema and migration.
- Do not use destructive migrations without explicit notes.

---

## 11. Secure Credential Storage

Create or reuse an encryption service.

Requirements:

- Use strong symmetric encryption.
- Use `ENCRYPTION_KEY`.
- Validate key length on startup.
- Encrypt Twilio Auth Token/API Secret.
- Encrypt Vobiz API Secret/Webhook Secret.
- Encrypt generated SIP passwords.
- Never send secrets back to frontend.
- Mask secrets in UI.
- Allow credential rotation.
- Do not log raw secrets.

Frontend display example:

```text
Account SID: AC************1234
Auth Token: ••••••••••••••••
Status: Connected
Last verified: May 27, 2026
```

---

## 12. Twilio Implementation

Twilio user flow:

1. User selects **Twilio**.
2. User enters friendly name, Account SID, and Auth Token or API Key SID/Secret.
3. Backend validates credentials.
4. Backend fetches Twilio phone numbers.
5. User selects voice-capable numbers.
6. App imports selected numbers.
7. User assigns a number to an app voice agent.
8. Backend creates LiveKit inbound SIP trunk.
9. Backend creates LiveKit dispatch rule.
10. Backend configures Twilio voice routing.
11. Incoming calls route into LiveKit.
12. LiveKit dispatches the correct AI agent.
13. App stores call logs and usage.

Twilio routes:

```text
POST /api/telephony/twilio/voice/:phoneNumberId
POST /api/telephony/twilio/status/:phoneNumberId
POST /api/telephony/twilio/fallback/:phoneNumberId
```

Preferred routing:

- Configure Twilio number voice webhook to the app.
- App responds with TwiML that dials LiveKit SIP.

Fallback TwiML:

```xml
<Response>
  <Say>Sorry, this voice agent is not available right now. Please try again later.</Say>
  <Hangup/>
</Response>
```

Implementation requirements:

- Use Twilio SDK or REST API.
- Validate credentials securely.
- Fetch `IncomingPhoneNumbers`.
- Confirm the number is voice-capable.
- Store Twilio phone number SID.
- Store previous Twilio routing config before overwriting it.
- Verify Twilio webhook signatures.
- Track Twilio status callbacks.
- Restore prior Twilio routing when user disconnects, if possible.

---

## 13. Vobiz / Vobiz.ai Implementation

Implement Vobiz through the same provider adapter.

Important:

- Inspect official Vobiz/Vobiz.ai docs or SDKs before implementing automatic API calls.
- Do not invent endpoints.
- If docs/API are unavailable, implement manual SIP setup mode.

### Mode A: Automatic Vobiz connection

Use only if verified Vobiz APIs exist.

Flow:

1. User enters Vobiz API credentials.
2. Backend validates credentials.
3. Backend fetches Vobiz phone numbers or SIP trunks.
4. User imports selected number.
5. Backend creates LiveKit inbound SIP trunk.
6. Backend creates LiveKit dispatch rule.
7. Backend configures Vobiz routing to LiveKit if API supports it.
8. Calls route into LiveKit.

### Mode B: Manual Vobiz setup

Use when automatic API support is unavailable.

Flow:

1. User selects Vobiz.
2. User chooses **Manual setup**.
3. User enters phone number, Vobiz account/workspace ID if known, SIP trunk ID if known, and optional webhook/signing secret.
4. Backend creates LiveKit inbound SIP trunk.
5. Backend creates LiveKit dispatch rule.
6. UI shows setup instructions:
   - LiveKit SIP host
   - SIP URI
   - SIP username
   - SIP password shown once
   - Transport
   - Webhook/status callback URL if needed
7. User configures Vobiz dashboard manually.
8. Number remains `pending_verification`.
9. User places a test call.
10. First valid LiveKit SIP event or Vobiz webhook marks the number verified.

Vobiz routes:

```text
POST /api/telephony/vobiz/inbound/:phoneNumberId
POST /api/telephony/vobiz/status/:phoneNumberId
POST /api/telephony/vobiz/verify/:phoneNumberId
```

UI copy:

```text
Automatic Vobiz sync is available only if your Vobiz account exposes API access. Otherwise use manual SIP setup.
```

---

## 14. Phone Number Verification

Users must not be able to claim random phone numbers.

### Twilio automatic verification

A Twilio number is verified only if:

- Twilio credentials are valid.
- The number is returned by Twilio for that account.
- The authenticated user imports it.
- The Twilio number SID is stored.

### Vobiz automatic verification

A Vobiz number is verified only if:

- Vobiz credentials are valid.
- The number is returned by a verified Vobiz API.
- Provider number/trunk ID is stored.

### Vobiz manual verification

For manual setup:

1. App creates number as `pending_verification`.
2. App generates verification metadata/token.
3. App creates LiveKit trunk and dispatch rule.
4. User configures Vobiz SIP routing.
5. User places test call.
6. App receives LiveKit SIP event or Vobiz webhook.
7. App validates number/metadata/secret.
8. App marks number `verified` and then `active`.

Statuses:

```text
pending_verification
verified
livekit_configured
active
error
disconnected
```

---

## 15. Backend API Routes

Add routes using existing backend conventions.

```text
GET    /api/telephony/providers

POST   /api/telephony/connections
GET    /api/telephony/connections
GET    /api/telephony/connections/:id
PATCH  /api/telephony/connections/:id
DELETE /api/telephony/connections/:id

POST   /api/telephony/connections/:id/validate
POST   /api/telephony/connections/:id/sync-numbers

GET    /api/telephony/phone-numbers
POST   /api/telephony/phone-numbers/import
POST   /api/telephony/phone-numbers/manual
GET    /api/telephony/phone-numbers/:id
PATCH  /api/telephony/phone-numbers/:id
DELETE /api/telephony/phone-numbers/:id

POST   /api/telephony/phone-numbers/:id/assign-agent
POST   /api/telephony/phone-numbers/:id/configure-livekit
POST   /api/telephony/phone-numbers/:id/test
POST   /api/telephony/phone-numbers/:id/disconnect

POST   /api/telephony/outbound-calls

POST   /api/telephony/twilio/voice/:phoneNumberId
POST   /api/telephony/twilio/status/:phoneNumberId
POST   /api/telephony/twilio/fallback/:phoneNumberId

POST   /api/telephony/vobiz/inbound/:phoneNumberId
POST   /api/telephony/vobiz/status/:phoneNumberId
POST   /api/telephony/vobiz/verify/:phoneNumberId

POST   /api/livekit/webhooks
POST   /api/livekit/token
POST   /api/livekit/rooms/:roomName/join
```

Security rules:

- All management routes require auth.
- Webhook routes verify provider signatures/secrets where possible.
- LiveKit webhook route verifies LiveKit webhook signatures/secrets.
- Users cannot access another user’s connections, numbers, agents, or calls.
- Validate all input with Zod or existing validation utilities.
- Validate phone numbers in E.164 format.

---

## 16. LiveKit Webhooks and Call Lifecycle

Handle LiveKit lifecycle events:

- Room created
- Room finished
- Participant joined
- Participant left
- SIP participant joined
- SIP participant left
- Agent participant joined
- Recording/transcription events if available

When a call starts:

1. Match LiveKit room/SIP participant to phone number.
2. Find assigned app agent.
3. Create or update `Call` record.
4. Start or confirm AI agent dispatch.
5. Mark call active.

When a call ends:

1. Mark call ended.
2. Save duration.
3. Save transcript if available.
4. Save summary if available.
5. Save recording URL if available.
6. Record usage minutes.
7. Update billing usage.

---

## 17. Agent Assignment

Rules:

- One active app voice agent per phone number initially.
- Recreate/update LiveKit dispatch rule when assignment changes.
- Incoming calls must resolve the correct assigned agent.
- If no agent is assigned, route to a safe fallback.
- Store assignment changes if history is useful.

Suggested LiveKit room prefix:

```text
call-{phoneNumberId}-
```

Suggested LiveKit metadata:

```json
{
  "userId": "...",
  "appAgentId": "...",
  "phoneNumberId": "...",
  "provider": "twilio-or-vobiz",
  "direction": "inbound"
}
```

---

## 18. Frontend UI

Add a dashboard navigation item:

```text
Phone Numbers
```

or:

```text
Telephony
```

### Phone Numbers page

Show:

- Heading: `Phone Numbers`
- Subtitle: `Connect Twilio or Vobiz numbers and route calls to your LiveKit voice agents.`
- Button: `Connect Number`
- Provider filter
- Status filter
- Search by number
- Connected numbers table/cards

Each phone number should show:

- Phone number
- Provider badge
- LiveKit status
- Verification status
- Assigned agent
- Inbound enabled
- Outbound enabled
- Last synced
- Last call
- Actions:
  - Assign agent
  - Configure LiveKit
  - Test call
  - View calls
  - Disconnect

### Connect Number Wizard

Step 1: Choose provider

- Twilio
- Vobiz / Vobiz.ai

Step 2: Connect provider

Twilio fields:

- Friendly name
- Account SID
- Auth Token
- API Key SID/Secret if supported
- Validate button

Vobiz fields:

- Friendly name
- API key
- API secret
- Account/workspace ID
- SIP trunk ID if known
- Webhook secret if known
- Manual setup toggle

Step 3: Select numbers

For automatic sync:

- Phone number
- Friendly name
- Voice capability
- Region/country
- Import checkbox

For Vobiz manual mode:

- Phone number
- Provider account ID
- SIP trunk ID
- Notes

Step 4: Assign agent

- Select voice agent
- Inbound enabled
- Outbound enabled
- Create LiveKit SIP trunk
- Create LiveKit dispatch rule

Step 5: Configure provider

Twilio:

- Auto-configure Twilio
- Show manual TwiML fallback

Vobiz:

- Show LiveKit SIP details
- Show SIP URI
- Show SIP host
- Show SIP username
- Show SIP password once
- Show setup checklist

Step 6: Test

- Call this number
- Watch verification status
- Show latest LiveKit room
- Show latest SIP participant
- Show latest call logs
- Show troubleshooting tips

---

## 19. Agent Detail Integration

On each voice agent detail page, add a **Phone Numbers** section.

Show:

- Assigned phone numbers
- Provider
- LiveKit status
- Inbound/outbound status
- Last call
- Button: `Assign Phone Number`
- Button: `Test via LiveKit`

Empty state:

```text
No phone number connected
Connect a Twilio or Vobiz number to let customers call this AI voice agent.
```

CTA:

```text
Connect Phone Number
```

---

## 20. Browser LiveKit Test Mode

Add browser-based LiveKit testing if feasible.

Flow:

1. User opens agent playground.
2. Backend creates LiveKit room.
3. Backend creates short-lived LiveKit token.
4. Agent worker joins the room.
5. User joins from browser using microphone.
6. User tests the agent before connecting a phone number.

UI:

- Join test room
- Mic permission state
- Mute/unmute
- End test
- Transcript panel
- Latency/status indicator
- Agent connection status

This is separate from production phone numbers.

---

## 21. Outbound Calls

Add outbound support where LiveKit SIP and provider setup allow it.

Flow:

1. User selects source phone number.
2. User enters destination number.
3. App checks plan/usage.
4. App checks number is verified and outbound-enabled.
5. Backend creates LiveKit outbound call/SIP participant.
6. Agent joins the room.
7. Call record is created.
8. Status is tracked.

API:

```text
POST /api/telephony/outbound-calls
```

Validation:

- Destination must be E.164.
- User must own source number.
- Number must have assigned agent.
- Plan must allow outbound calls.
- Usage limits must not be exceeded.

If outbound is not supported for a provider, disable the button and show a clear explanation.

---

## 22. Plan Limits and Billing Gates

Integrate with existing pricing/billing if present.

Suggested limits:

### Free

- Browser test only
- No production phone number connection

### Starter

- 1 connected phone number
- Twilio BYO support
- Limited monthly call minutes

### Pro

- 5 connected phone numbers
- Twilio BYO
- Vobiz manual setup
- More call minutes
- Call logs/transcripts

### Agency

- 25+ connected phone numbers
- Twilio + Vobiz
- Multiple agents/numbers
- Advanced routing
- Higher call minutes
- Priority support

Backend must enforce:

- Max connected numbers
- Max call minutes
- Outbound call access
- Provider availability by plan
- Advanced routing by plan

Frontend upgrade prompt examples:

```text
Your current plan does not include production phone numbers. Upgrade to connect Twilio or Vobiz numbers.
```

```text
You’ve reached your connected phone number limit.
```

---

## 23. Security Requirements

Implement securely:

- Encrypt all provider credentials.
- Encrypt generated SIP passwords.
- Never expose provider secrets after saving.
- Verify Twilio signatures on webhooks.
- Verify LiveKit webhooks.
- Verify Vobiz webhook signatures if supported.
- Use idempotency for webhook events.
- Prevent cross-user access.
- Validate E.164 phone numbers.
- Validate provider number ownership.
- Store previous provider routing config before overwriting it.
- Do not log secrets.
- Rate-limit credential validation and webhook endpoints if infrastructure exists.
- Add safe fallback behavior when routing fails.

---

## 24. Error Handling

Handle these cases:

- Invalid Twilio credentials
- Invalid Vobiz credentials
- No numbers found
- Number already imported
- Number belongs to another user
- LiveKit env missing
- LiveKit trunk creation failed
- LiveKit dispatch rule creation failed
- Twilio webhook setup failed
- Vobiz manual setup incomplete
- Agent not assigned
- Plan limit reached
- Call received for unknown number
- LiveKit room creation failed
- Agent worker unavailable
- SIP participant failed
- Outbound call failed

User-facing messages:

```text
We connected your Twilio account, but no voice-capable numbers were found.
```

```text
LiveKit routing was created, but Twilio webhook setup failed. Copy the TwiML below and configure it manually.
```

```text
This Vobiz number is pending verification. Route it to the LiveKit SIP details below and place a test call.
```

---

## 25. Testing Checklist

Add automated tests where possible.

Test:

- LiveKit token creation
- LiveKit trunk creation service
- LiveKit dispatch rule creation service
- Twilio credential validation
- Twilio number sync
- Twilio number import
- Twilio TwiML generation
- Twilio webhook signature validation
- Vobiz manual number setup
- Vobiz verification flow
- Agent assignment
- Cross-user access prevention
- Plan limit enforcement
- Encrypted credential storage
- Phone number disconnect
- Call lifecycle updates
- LiveKit webhook handling
- Outbound call validation

Manual test checklist:

1. Add LiveKit env vars.
2. Connect Twilio account.
3. Sync Twilio numbers.
4. Import a Twilio number.
5. Assign number to an agent.
6. Create LiveKit inbound trunk.
7. Create LiveKit dispatch rule.
8. Configure Twilio voice routing.
9. Call Twilio number.
10. Confirm LiveKit room is created.
11. Confirm SIP participant joins.
12. Confirm AI agent joins.
13. Confirm call record is created.
14. Confirm call transcript/status is saved if supported.
15. Disconnect number and restore prior Twilio config if possible.
16. Add Vobiz number manually.
17. Configure Vobiz with LiveKit SIP details.
18. Place verification call.
19. Confirm number becomes active.
20. Test outbound call if enabled.

Run:

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```

Fix all build/type/lint errors.

If tests are blocked by missing Twilio, Vobiz, or LiveKit credentials, document exactly what credentials are required and what could not be tested.

---

## 26. Documentation to Add

Create or update:

```text
docs/livekit-telephony.md
docs/byo-phone-numbers.md
docs/twilio-setup.md
docs/vobiz-setup.md
.env.example
README.md
```

Document:

- How LiveKit works in this app
- How BYO numbers work
- How to configure LiveKit Cloud
- Required LiveKit env vars
- How to connect Twilio
- How to connect Vobiz
- Manual Vobiz SIP setup
- How dispatch rules map numbers to agents
- How call records are created
- How to test inbound calls
- How to test outbound calls
- Troubleshooting
- Security notes

---

## 27. Implementation Deliverables

After implementation, provide:

1. Audit summary
   - Existing LiveKit support
   - Existing Twilio support
   - Existing Vobiz support
   - Existing telephony/call support

2. Architecture summary
   - Provider adapter design
   - LiveKit SIP design
   - Agent runtime design
   - Database design
   - API routes

3. Twilio implementation summary
   - Credentials
   - Number sync
   - Number import
   - LiveKit SIP routing
   - Webhooks/status callbacks
   - TwiML generation

4. Vobiz implementation summary
   - Automatic support if available
   - Manual setup support
   - LiveKit SIP details
   - Verification flow
   - Limitations

5. LiveKit implementation summary
   - Packages added
   - Env vars
   - Token generation
   - SIP trunk creation
   - Dispatch rule creation
   - Room/call lifecycle
   - Agent runtime/worker

6. Security summary
   - Encryption
   - Webhook verification
   - User isolation
   - Secret handling
   - Plan enforcement

7. Files changed
   - Path
   - Purpose

8. Testing summary
   - Commands run
   - Results
   - Manual tests completed
   - Blocked tests

9. Known limitations
   - Missing provider docs
   - Credentials required
   - Production setup required
   - Outbound call limitations

---

## 28. Final Quality Checklist

Before finishing, verify:

- LiveKit packages are installed correctly.
- LiveKit env vars are documented.
- Backend can generate LiveKit tokens.
- Backend can create LiveKit SIP trunks.
- Backend can create LiveKit dispatch rules.
- User can connect Twilio credentials.
- User can sync Twilio phone numbers.
- User can import Twilio number.
- User can connect/add Vobiz number.
- User can manually configure Vobiz SIP routing.
- User can assign a number to an agent.
- Incoming call routes to LiveKit.
- LiveKit room is created.
- Correct agent is dispatched.
- Call record is created.
- Usage is tracked.
- Webhooks are verified.
- Provider credentials are encrypted.
- Cross-user access is blocked.
- Plan limits are enforced.
- Frontend UI is polished and responsive.
- Build, lint, typecheck, and tests pass.

---

## 29. Starter Prompt for Coding Agent

Use this with Codex, Claude Code, Cursor, or Windsurf:

```text
Analyze the repo first, then add production-ready BYO phone numbers for Twilio and Vobiz/Vobiz.ai using LiveKit SIP and LiveKit Agents as the realtime voice layer. Build secure provider connections, encrypted credentials, phone number import/manual setup, LiveKit trunk/dispatch creation, agent assignment, inbound/outbound call routing, webhooks, call logs, plan limits, UI, docs, and tests. Do not build fake UI only. Follow docs/livekit-byo-phone-numbers-implementation.md exactly.
```

---

## Final Goal

The app should have a production-ready BYO phone number system using:

- Twilio and Vobiz/Vobiz.ai as phone number providers
- LiveKit as the realtime SIP/voice-agent layer
- Secure encrypted provider credentials
- Phone number import/manual setup
- LiveKit SIP trunk and dispatch rule creation
- Agent assignment
- Inbound and outbound call routing
- Webhooks
- Call logs and usage tracking
- Plan limits
- Polished dashboard UI
- Clear docs and tests
