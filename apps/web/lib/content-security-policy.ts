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
