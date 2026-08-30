# 24 — Environment Variables

## Frontend
```env
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SENTRY_DSN=
# Only when the web app is deployed apart from the API. Middleware otherwise
# reads the shared LIVEKIT_URL to allow the LiveKit socket in the CSP.
NEXT_PUBLIC_LIVEKIT_URL=
```

## Backend
```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/voiceforge
DIRECT_URL=postgresql://user:password@localhost:5432/voiceforge
REDIS_URL=redis://localhost:6379
ENCRYPTION_KEY=
# Optional AES-256-GCM keyring: `kid:key` pairs joined by commas, each key 64 hex
# characters (32 bytes), kid matching [A-Za-z0-9_-]{1,32}. Unset is the normal
# state. The FIRST pair encrypts every new value; the rest exist only so rows
# written earlier keep decrypting, so rotating is "prepend a new pair" and an old
# pair is never deleted. `ENCRYPTION_KEY` is always in the ring under the key id
# `legacy`, which is what rows carrying no key id (everything written before the
# ring existed) decrypt with — so `legacy` cannot be reused here, and
# ENCRYPTION_KEY's value can never change.
ENCRYPTION_KEYS=
JWT_SECRET=
# Required. Boot fails without it, because it binds the `issuer` claim when the
# API verifies a Supabase JWT. Falls back to NEXT_PUBLIC_SUPABASE_URL if unset.
SUPABASE_URL=
# At least one of these two is required in production and boot refuses without
# either: they are the only two ways to establish a session's claims (local
# HS256 verification, or token introspection). With neither, the API starts
# healthy and then rejects every authenticated request.
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
SUPABASE_KNOWLEDGE_BUCKET=knowledge-files
AUTH_PROVIDER=supabase
# Required, min 32 chars. Shared secret presented as the `x-internal-key`
# header on every request that is not @Public(). The Next.js app is the main
# caller but not the only one — see ## Auth for all four entry modes.
INTERNAL_API_KEY=
```

## Auth
Supabase Auth is the only provider — `AUTH_PROVIDER` accepts no other value. The
browser holds the Supabase session cookie; the Next.js server forwards the access
token to the API as a bearer token alongside `INTERNAL_API_KEY`, and the API
verifies the JWT (locally with `SUPABASE_JWT_SECRET`, otherwise against
`SUPABASE_URL/auth/v1/user`). Every auth variable is listed under Frontend or
Backend above.

`InternalAuthGuard` (`apps/api/src/auth/internal-auth.guard.ts`) has four entry
modes, not one:

1. **User session** — `x-internal-key` plus an `Authorization: Bearer` Supabase
   access token. Every ordinary tenant route.
2. **Internal platform call** — `x-internal-key` with *no* bearer token. Accepted
   only on routes declaring `@InternalOnly()`; on any other route a key-only
   request is refused, and a request carrying user context is refused on an
   `@InternalOnly()` route.
3. **`@Public()` routes** — health and metrics. No credentials at all; the guard
   returns before it looks at any header.
4. **Provider webhooks** — also `@Public()`, authenticated by provider signature
   instead. Three of those signatures come from an env var
   (`VOICE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`, and `TWILIO_AUTH_TOKEN` for
   the legacy platform-owned Twilio voice webhooks); the BYO telephony ones do
   not — see ## Voice.

## LLM
```env
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
DEFAULT_LLM_PROVIDER=openai
```

## Voice
Vapi and Retell were removed in 2026-08. `VOICE_PROVIDER` accepts `mock`
(non-production only), `twilio`, or `openai-realtime`; a retired value is coerced
to `openai-realtime` with a deprecation warning rather than failing boot. See
`docs/RUNBOOK.md` §2 for the migration.

No webhook secret is configured here, and there is no `LIVEKIT_WEBHOOK_SECRET` or
`VOBIZ_WEBHOOK_SECRET` — both used to be listed and neither was ever read by any
code. Inbound LiveKit webhooks are verified with `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET` (the SDK's `WebhookReceiver` validates the request's
`Authorization` JWT against them); Vobiz webhooks are verified with a
**per-phone-number** secret VoiceForge stores encrypted on the number itself, so
no environment variable secures those.

Twilio has two webhook families and only one of them is env-free:

| Family | Routes | Signing secret |
| --- | --- | --- |
| BYO telephony | `telephony/` | the provider connection's decrypted `authToken`, falling back to the number's per-number secret |
| Legacy platform-owned | `twilio-adapter/` | the account-level **`TWILIO_AUTH_TOKEN`** below — `TwilioSignatureVerifier` rejects every delivery when it is unset, because those `TwilioPhoneNumber` rows carry no provider connection |

```env
VOICE_PROVIDER=openai-realtime
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_SIP_DOMAIN=
TWILIO_TWIML_WEBHOOK_URL=
TWILIO_STATUS_WEBHOOK_URL=
# Also consumed by the web app's CSP: browser test calls on the in-house
# pipeline open a WebSocket to this host, so it must be visible to Next.js
# middleware (directly or via NEXT_PUBLIC_LIVEKIT_URL).
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_SIP_HOST=your-project.sip.livekit.cloud
LIVEKIT_ROOM_PREFIX=call
LIVEKIT_AGENT_NAME_PREFIX=voiceforge-agent
VOBIZ_DEFAULT_SIP_DOMAIN=
OPENAI_API_KEY=
OPENAI_REALTIME_BASE_URL=https://api.openai.com/v1
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=marin
```

## In-house voice pipeline (Azure STT → LLM → TTS)
The `standard` pipeline is the only runtime the free plan may use and serves half
of starter-plan calls. Enabling it in production requires every variable below
except `AZURE_TTS_VOICE` and `AZURE_OPENAI_API_VERSION`, or the API refuses to
boot. The same variables must reach the `livekit-agent` worker.
```env
VOICE_STANDARD_PIPELINE_ENABLED=false
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=
AZURE_VOICE_LLM_DEPLOYMENT=
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
AZURE_TTS_VOICE=en-US-AvaMultilingualNeural
```

## Storage, Analytics, Billing
```env
S3_BUCKET=
S3_REGION=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
CLICKHOUSE_URL=
CLICKHOUSE_USER=
CLICKHOUSE_PASSWORD=
WEB_BASE_URL=http://localhost:3000
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_STARTER_PRICE_ID=
STRIPE_GROWTH_PRICE_ID=
STRIPE_ENTERPRISE_PRICE_ID=
STRIPE_MINUTE_PACK_PRICE_ID=
FREE_CREDIT_GRANT_CRON=15 0 * * *
```

Use server-only Stripe price IDs. Do not expose `NEXT_PUBLIC_STRIPE_*_PRICE_ID` variables.
In production, prefer an `rk_live_...` restricted Stripe key with only Billing, Checkout, Customer, Invoice, and Subscription permissions.
