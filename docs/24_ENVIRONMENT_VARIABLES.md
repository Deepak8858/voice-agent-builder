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
JWT_SECRET=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
SUPABASE_KNOWLEDGE_BUCKET=knowledge-files
AUTH_PROVIDER=supabase
```

## Auth
```env
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=
AUTH0_DOMAIN=
AUTH0_CLIENT_ID=
AUTH0_CLIENT_SECRET=
WORKOS_API_KEY=
```

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
LIVEKIT_WEBHOOK_SECRET=
LIVEKIT_ROOM_PREFIX=call
LIVEKIT_AGENT_NAME_PREFIX=voiceforge-agent
VOBIZ_WEBHOOK_SECRET=
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
