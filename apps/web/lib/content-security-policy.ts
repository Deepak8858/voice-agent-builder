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
 */
export function buildContentSecurityPolicy(nonce: string): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const supabaseOrigins = 'https://*.supabase.co https://*.supabase.com';
  const monacoCdn = 'https://cdn.jsdelivr.net';

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' ${monacoCdn}`,
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline' ${monacoCdn}`,
    `img-src 'self' data: blob: ${supabaseOrigins}`,
    `font-src 'self' data: ${monacoCdn}`,
    `connect-src 'self' ${apiUrl} ${supabaseOrigins} https://api.stripe.com`,
    `frame-src 'self' https://checkout.stripe.com ${supabaseOrigins}`,
    `worker-src 'self' blob: ${monacoCdn}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}
