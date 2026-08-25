/**
 * Builds the per-request Content-Security-Policy.
 *
 * PostHog deliberately adds **no** origins here. The browser SDK is pointed at
 * the same-origin proxy prefix (`POSTHOG_PROXY_PREFIX`), so every PostHog
 * request — ingestion, flags, lazily-loaded `/static/` bundles, `/array/`
 * remote config and session replay — is already covered by `'self'`:
 *
 *  - `connect-src 'self'` covers capture, flags and replay ingestion.
 *  - `script-src 'self'` plus `'strict-dynamic'` covers the SDK's lazily
 *    injected bundles, which are fetched through the proxy.
 *  - `worker-src 'self' blob:` covers the replay compression worker.
 *
 * Allowing `*.posthog.com` directly would defeat the proxy: the SDK would still
 * work if the rewrite broke, so a misconfigured proxy would go unnoticed, and
 * the closed `connect-src` would be widened for no benefit. If a PostHog
 * request ever appears as a CSP violation against a third-party origin, the
 * fix is the proxy, not this file.
 *
 * LiveKit, by contrast, cannot be proxied: browser test calls on the in-house
 * pipeline open a signalling WebSocket straight to the LiveKit server and then
 * exchange media over WebRTC, so its origin has to be in `connect-src`. The URL
 * is normalised to an origin (a `wss://` URL also needs its `https://` form,
 * since the SDK fetches over HTTP too) and is simply omitted when unset, so a
 * deployment without the in-house pipeline keeps the tighter policy.
 * `media-src blob:` is required because the SDK attaches remote tracks through
 * blob-backed media elements.
 *
 * This function only runs in middleware, so it can read the unprefixed
 * `LIVEKIT_URL` that API and worker deployments already share. That avoids
 * duplicating the value as a second build-time variable while still honouring
 * `NEXT_PUBLIC_LIVEKIT_URL` for hosts (e.g. Vercel) where the web app is
 * configured independently. The URL is not a secret — the API hands it to the
 * browser in every test-session response.
 */
export function buildContentSecurityPolicy(nonce: string): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const supabaseOrigins = 'https://*.supabase.co https://*.supabase.com';
  const monacoCdn = 'https://cdn.jsdelivr.net';
  const livekitOrigins = livekitConnectOrigins(
    process.env.NEXT_PUBLIC_LIVEKIT_URL ?? process.env.LIVEKIT_URL,
  );

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' ${monacoCdn}`,
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline' ${monacoCdn}`,
    `img-src 'self' data: blob: ${supabaseOrigins}`,
    `font-src 'self' data: ${monacoCdn}`,
    `media-src 'self' blob:`,
    [`connect-src 'self'`, apiUrl, supabaseOrigins, 'https://api.stripe.com', livekitOrigins]
      .filter(Boolean)
      .join(' '),
    `frame-src 'self' https://checkout.stripe.com ${supabaseOrigins}`,
    `worker-src 'self' blob: ${monacoCdn}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * The `connect-src` entries a LiveKit server URL needs, or `''` when there is no
 * usable URL. A malformed value yields no entries rather than injecting garbage
 * into the policy.
 */
function livekitConnectOrigins(rawUrl: string | undefined): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return '';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }

  const host = parsed.host;
  if (!host) return '';

  switch (parsed.protocol) {
    case 'wss:':
      return `wss://${host} https://${host}`;
    case 'ws:':
      return `ws://${host} http://${host}`;
    case 'https:':
      return `https://${host} wss://${host}`;
    case 'http:':
      return `http://${host} ws://${host}`;
    default:
      return '';
  }
}
