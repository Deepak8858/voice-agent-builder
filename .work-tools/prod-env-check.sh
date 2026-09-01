#!/usr/bin/env bash
# Read-only production audit helper. Prints env var NAMES and presence only.
# Never prints secret values.
cd /opt/voiceforge || exit 1

echo "=== ENV VAR NAMES (all) ==="
cut -d= -f1 .env | grep -v '^#' | grep -v '^$' | sort

echo ""
echo "=== CRITICAL PRESENCE CHECK (SET/MISSING only) ==="
for k in VOICE_WEBHOOK_SECRET VOICE_PROVIDER DODO_PAYMENTS_API_KEY DODO_WEBHOOK_SECRET \
         BILLING_DISABLED REDIS_URL SUPABASE_JWT_SECRET SUPABASE_SERVICE_ROLE_KEY \
         LIVEKIT_API_KEY LIVEKIT_URL LIVEKIT_SIP_HOST RESEND_API_KEY WORKERS_ENABLED TRUST_PROXY_HOPS \
         ENCRYPTION_KEY JWT_SECRET ALLOWED_ORIGINS DEEPGRAM_API_KEY; do
  if grep -q "^${k}=." .env; then
    echo "${k}: SET"
  else
    echo "${k}: MISSING_OR_EMPTY"
  fi
done

echo ""
echo "=== NODE_ENV / billing mode / VOICE_PROVIDER (non-secret values) ==="
grep -E '^(NODE_ENV|BILLING_DISABLED|DODO_PAYMENTS_ENVIRONMENT|VOICE_PROVIDER|AUTH_PROVIDER|LLM_PROVIDER|WORKERS_ENABLED|TRUST_PROXY_HOPS)=' .env || true

echo ""
echo "=== COMPOSE SERVICES DEFINED ==="
grep -E '^  [a-z0-9-]+:' docker-compose.azure.yml || true
