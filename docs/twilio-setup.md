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

That route returns TwiML with `<Dial><Sip>sip:<LIVEKIT_SIP_HOST></Sip></Dial>`.

## Security

- Twilio credentials are encrypted before storage.
- Twilio provider logic is isolated in `apps/api/src/telephony/providers/twilio.provider.ts`.
- Status callbacks are stored idempotently in `telephony_webhook_events`.
- Previous routing metadata is captured during number sync when Twilio returns it.
