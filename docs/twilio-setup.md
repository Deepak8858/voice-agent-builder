# Twilio BYO Setup

1. Set LiveKit env vars in `.env`.
2. Open `Dashboard -> Phone Numbers`.
3. Select `Connect Twilio numbers` and enter Account SID plus Auth Token.
4. Pick the voice-capable numbers to import.
5. Assign each number to a published VoiceForge agent. That is the last step: assignment
   provisions the LiveKit SIP trunk and dispatch rule, and attaches the number to the Twilio
   trunk. `Reconfigure` on the number card repeats it if anything failed.

Connecting the account creates an Elastic SIP trunk named `VoiceForge` inside it, with:

- an origination URI pointing at `sip:<LIVEKIT_SIP_HOST>;transport=tcp`, so inbound calls reach
  the media plane with the dialled number in the request URI;
- a termination credential list, so outbound calls through the trunk's own SIP domain are
  authenticated rather than open to anyone who learns the domain.

Assignment then attaches the number to that trunk. Attaching moves the number off Programmable
Voice, so no Voice URL is written and no TwiML is served: the trunk is the whole inbound path.
Disconnecting a number, or reconfiguring it, detaches it from the trunk again.

The legacy TwiML webhook (`/api/v1/telephony/twilio/voice/:phoneNumberId`, validated with
`X-Twilio-Signature`) is still served for numbers connected before the trunk flow existed, and is
still used as the routing fallback when the Trunking API refuses the attachment.

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
