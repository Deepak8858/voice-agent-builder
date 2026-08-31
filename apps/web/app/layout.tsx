import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Script from 'next/script';
import { DM_Sans, DM_Serif_Display, IBM_Plex_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { ClientChrome } from '@/components/layout/client-chrome';
import { QueryProvider } from '@/components/providers/query-provider';
import { siteUrl } from '@/lib/site-url';
import { JsonLd } from '@/lib/seo';
import { organizationJsonLd, webSiteJsonLd } from './site-structured-data';
import './globals.css';

const dmSans = DM_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

const dmSerif = DM_Serif_Display({
  variable: '--font-serif',
  subsets: ['latin'],
  weight: ['400'],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
});

const siteName = 'VoiceForge AI';
const siteTitle = 'VoiceForge AI — Spec-First Voice Agent Platform';
const siteDescription =
  'Build, test, govern, deploy, and white-label reliable AI voice agents from a reviewable Agent Spec JSON contract.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: siteTitle,
  description: siteDescription,
  applicationName: siteName,
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    siteName,
    title: siteTitle,
    description: siteDescription,
    url: '/',
    images: [
      {
        url: '/images/voiceforge-builder-preview.png',
        width: 1043,
        height: 552,
        alt: 'VoiceForge builder showing the prompt-to-Agent-Spec workflow',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: siteDescription,
    images: ['/images/voiceforge-builder-preview.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The middleware issues a fresh CSP nonce per request. Nonce-based CSP only
  // works when pages are rendered per request: statically prerendered HTML
  // carries no nonce attributes, so the browser blocks Next.js's inline
  // bootstrap scripts and the app never hydrates. Reading the request headers
  // opts every route into dynamic rendering, which lets Next.js pick the
  // nonce up from the Content-Security-Policy request header and stamp it
  // onto its inline scripts.
  await headers();
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmSerif.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col overflow-x-hidden bg-background text-foreground">
        <JsonLd data={[organizationJsonLd(), webSiteJsonLd()]} />
        <ClientChrome />
        <QueryProvider>
          <main className="flex flex-1 flex-col">{children}</main>
        </QueryProvider>
        <Toaster richColors position="top-right" />
        {/* Google Analytics. The measurement id is public by design. Rendered
            only in production so local and CI sessions never pollute the
            property; next/script injects both tags after hydration, which the
            CSP's 'strict-dynamic' trusts (its origins are also named in
            content-security-policy.ts for CSP2 browsers). Keep it a single
            gtag — Google warns against loading more than one per page. */}
        {process.env.NODE_ENV === 'production' ? (
          <>
            <Script
              src="https://www.googletagmanager.com/gtag/js?id=G-XPNTRFSGLV"
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-XPNTRFSGLV');`}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}
