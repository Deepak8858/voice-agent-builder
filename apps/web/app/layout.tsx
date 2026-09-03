import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Script from 'next/script';
import { DM_Sans, DM_Serif_Display, IBM_Plex_Mono } from 'next/font/google';
import { ClientChrome } from '@/components/layout/client-chrome';
import { QueryProvider } from '@/components/providers/query-provider';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { AppToaster } from '@/components/providers/app-toaster';
import { siteUrl } from '@/lib/site-url';
import { JsonLd } from '@/lib/seo';
import { organizationJsonLd, webSiteJsonLd } from './site-structured-data';
import './globals.css';

// `display: 'swap'` plus `adjustFontFallback` keeps text visible immediately and
// sizes the fallback to the real font's metrics, so the oversized serif h1 does
// not reflow when the webfont lands. That reflow was the bulk of a 0.152 mobile CLS.
const dmSans = DM_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  adjustFontFallback: true,
});

const dmSerif = DM_Serif_Display({
  variable: '--font-serif',
  subsets: ['latin'],
  weight: ['400'],
  display: 'swap',
  adjustFontFallback: true,
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  adjustFontFallback: true,
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
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmSerif.variable} ${ibmPlexMono.variable} h-full antialiased`}
      // The theme script below adds `.dark` before React hydrates, so the
      // server's class list is expected to differ from the client's.
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col overflow-x-hidden bg-background text-foreground">
        {/* Applies the saved theme before the browser paints. Doing it in an
            effect would run after the light palette is already on screen, which
            is the white flash every class-based dark mode has to avoid. Inline
            and nonce'd rather than a module so it blocks paint; the key must
            match THEME_STORAGE_KEY in the theme provider. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=localStorage.getItem('voiceforge-theme');var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})();`,
          }}
        />
        <JsonLd data={[organizationJsonLd(), webSiteJsonLd()]} />
        <ThemeProvider>
          <ClientChrome />
          <QueryProvider>
            <main className="flex flex-1 flex-col">{children}</main>
          </QueryProvider>
          <AppToaster />
        </ThemeProvider>
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
// Consent Mode v2. No ads product is in use, so every ad signal is denied
// everywhere. Analytics cookies are denied by default in the jurisdictions
// that require opt-in consent (EEA + UK + CH) — GA then falls back to
// cookieless aggregate pings there — and granted elsewhere. Region-scoped
// defaults take precedence over the general one, and both must be set
// before gtag('js'). If a consent banner ever ships, it flips these with
// gtag('consent','update',...) instead of adding a second tag.
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'granted'
});
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  region: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH']
});
gtag('js', new Date());
gtag('config', 'G-XPNTRFSGLV');`}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}
