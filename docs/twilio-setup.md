# Twilio BYO Setup

1. Set LiveKit env vars in `.env`.
2. Open `Dashboard -> Phone Numbers`.
3. Select `Connect Number`, choose `Twilio`, and enter Account SID plus Auth Token.
4. Sync numbers and import the voice-capable numbers for the workspace.
5. Assign each number to a published VoiceForge agent.
6. Select `Configure` to create the LiveKit SIP trunk and dispatch rule.

VoiceForge updates the Twilio Incoming Phone Number Voice URL to:

```txt
/api/v1/telephony/twilio/voice/:phoneNumberId
```

It also sets:

```txt
VoiceFallbackUrl=/api/v1/telephony/twilio/fallback/:phoneNumberId
StatusCallback=/api/v1/telephony/twilio/status/:phoneNumberId
```

The voice route validates `X-Twilio-Signature` with the connected account Auth Token, then returns TwiML with `<Dial><Sip>sip:<LIVEKIT_SIP_HOST></Sip></Dial>`.

## Environment

Twilio BYO account credentials are entered per workspace in the UI and encrypted in PostgreSQL. The server still needs these shared deployment values:

```env
APP_BASE_URL=https://<your-domain>
LIVEKIT_URL=wss://<your-livekit-project>.livekit.cloud
LIVEKIT_API_KEY=<livekit-api-key>
LIVEKIT_API_SECRET=<livekit-api-secret>
LIVEKIT_SIP_HOST=<your-livekit-project>.sip.livekit.cloud
OPENAI_API_KEY=<openai-api-key>
OPENAI_REALTIME_MODEL=gpt-realtime-2
ENCRYPTION_KEY=<32-byte key, for example 64 hex chars>
```

Outbound SIP needs no platform-wide domain: VoiceForge creates an Elastic SIP trunk inside the customer's own Twilio account when they connect it, and both call directions use that trunk's termination domain and SIP credential. The legacy `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_TWIML_WEBHOOK_URL`, and `TWILIO_STATUS_WEBHOOK_URL` variables are for the older platform-owned Twilio voice adapter, not the BYO LiveKit flow.

## Security

- Twilio credentials are encrypted before storage.
- Twilio inbound and status webhooks must pass signature validation.
- Twilio provider logic is isolated in `apps/api/src/telephony/providers/twilio.provider.ts`.
- Status callbacks are stored idempotently in `telephony_webhook_events`.
- Previous routing metadata is captured during number sync when Twilio returns it.
