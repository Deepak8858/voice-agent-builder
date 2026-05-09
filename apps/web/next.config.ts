import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const supabaseOrigins = [
      'https://*.supabase.co',
      'https://*.supabase.com',
    ].join(' ');
    const monacoCdn = 'https://cdn.jsdelivr.net';
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-eval' 'unsafe-inline' ${supabaseOrigins} ${monacoCdn}`,
      `style-src 'self' 'unsafe-inline' ${monacoCdn}`,
      `img-src 'self' data: blob: ${supabaseOrigins}`,
      `font-src 'self' data: ${monacoCdn}`,
      `connect-src 'self' ${apiUrl} ${supabaseOrigins} https://api.stripe.com`,
      `frame-src 'self' https://checkout.stripe.com ${supabaseOrigins}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
