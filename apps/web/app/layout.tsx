import type { Metadata } from 'next';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
