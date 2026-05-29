# LiveKit Telephony

VoiceForge uses LiveKit SIP for BYO phone-number routing. The app stores provider-owned numbers, creates LiveKit inbound trunks, creates dispatch rules, and dispatches LiveKit Agents with job metadata that includes the workspace, phone number, agent, provider, direction, and `gpt-realtime-2` model.

## Required Environment

```env
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_SIP_HOST=your-project.sip.livekit.cloud
LIVEKIT_WEBHOOK_SECRET=
LIVEKIT_ROOM_PREFIX=call
LIVEKIT_AGENT_NAME_PREFIX=voiceforge-agent
OPENAI_REALTIME_MODEL=gpt-realtime-2
```

`LIVEKIT_API_SECRET` is backend-only. The browser should receive only short-lived room tokens.

## Runtime Flow

1. A workspace imports or manually adds a Twilio or Vobiz number.
2. The number is assigned to one VoiceForge agent.
3. `Configure LiveKit` creates an inbound trunk and dispatch rule.
4. Provider routing points inbound calls to the LiveKit SIP host.
5. LiveKit creates a room with a `call-<phoneNumberId>-` prefix and dispatches the configured agent.
6. VoiceForge records call and webhook events for status, transcript, usage, and audit trails.

Outbound calls use LiveKit `createSipParticipant` when the number has an outbound trunk domain configured.
