# Cloudflare Integration Roadmap — VoiceForge (incfrog.ai)

Tracks how we adopt Cloudflare across the product. The $10k startup credits cover the
usage-based items; AI Gateway core is free and needs no credits. Azure token spend
stays on the Azure account ($1000 startup credit).

## Phase 1 — Now (chat-to-agent generation rebuild)
- **AI Gateway (free)** in front of Azure AI Foundry `gpt-5.4-mini`:
  - Proxy via `LLM_BASE_URL` → gateway Azure OpenAI endpoint (BYOK, no markup).
  - Response caching (identical prompt → cached spec, saves Azure tokens).
  - Gateway-level rate limiting as a backstop behind our per-user API limiter.
  - Analytics: tokens, cost, latency per request in the dashboard.
  - Spend limits: dollar budget on the gateway so a runaway loop can never burn the
    Azure credit (e.g. $50/day cap, block on exceed).
  - Covers BOTH generation paths automatically (chat sessions + spec builder), since
    both go through the same LLM adapter.

## Phase 2 — Edge & delivery (uses credits)
- **DNS + CDN for incfrog.ai**: move DNS to Cloudflare, proxy web traffic, cache static
  assets ahead of nginx/EC2. Free tier + program perks (enterprise domain, WAF).
- **WAF + DDoS + Bot management**: protect `/api/*`, block scraping/bot signups.
- **Rate Limiting rules at the edge**: coarse IP-level limits in front of the API
  (login, signup, webhook endpoints) before traffic ever reaches EC2.
- **Turnstile**: CAPTCHA-free bot verification on signup/login and public agent share
  pages (`/a/:slug`) to stop abuse of the demo endpoints.

## Phase 3 — Storage & media (uses credits)
- **R2 (up to $10k covered)**: knowledge-source file uploads and call recordings.
  Zero egress fees matter for audio playback; replaces/augments Supabase storage
  (`KNOWLEDGE_STORAGE_PROVIDER=s3`-compatible, R2 is S3 API compatible).
- **Stream**: hosted playback for demo audio / recorded calls on public share pages.
- **Cache Reserve**: long-tail caching of public agent pages and demo assets.

## Phase 4 — Compute & realtime (evaluate)
- **Workers**: lightweight edge endpoints — public agent share page rendering,
  webhook signature pre-validation, geo-routing.
- **Durable Objects**: per-call realtime coordination / live transcript fanout to
  dashboards (WebSocket) without loading the NestJS API.
- **Queues**: buffer voice-provider webhooks during spikes before they hit the API.
- **Workers AI (up to $2.5k covered)**: cheap fallback model for non-critical tasks
  (call summaries, keyword tagging) when Azure is down or budget-capped — wire as an
  AI Gateway fallback route.

## Phase 5 — Observability & governance
- **AI Gateway dynamic routing**: fallback chain `azure/gpt-5.4-mini` → Workers AI open
  model on 5xx/timeout/spend-cap so agent generation never hard-fails.
- **Logpush** (needs Workers Paid $5/mo): export gateway logs to R2 for long-term
  audit of LLM usage per workspace.
- **DLP profiles (free)**: scan prompts for financial/ID numbers before they leave
  for the LLM — compliance story for enterprise customers.

## Non-goals / stays as-is
- Voice runtime (LiveKit/Twilio/Vapi SIP paths) stays on current infra — realtime
  audio does not route through Cloudflare.
- Postgres (Supabase) and Redis stay where they are.

## Credit accounting quick reference
- AI Gateway core: free, no credits used.
- R2: covered up to $10,000.
- Workers AI: covered up to $2,500 (Tier 3).
- Registrar (domain renewal): NOT covered by credits.
- Credits valid 12 months from program acceptance.
