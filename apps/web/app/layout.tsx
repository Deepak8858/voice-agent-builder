import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { DM_Sans, DM_Serif_Display, IBM_Plex_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { ClientChrome } from '@/components/layout/client-chrome';
import { QueryProvider } from '@/components/providers/query-provider';
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

export const metadata: Metadata = {
  title: 'VoiceForge AI — Build Voice Agents That Answer',
  description: 'Design, test, deploy, and white-label AI voice calling agents using natural language.',
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
        <ClientChrome />
        <QueryProvider>
          <main className="flex flex-1 flex-col">{children}</main>
        </QueryProvider>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
