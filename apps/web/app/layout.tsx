import type { Metadata } from 'next';
import { DM_Sans, DM_Serif_Display, IBM_Plex_Mono } from 'next/font/google';
import Link from 'next/link';
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from '@clerk/nextjs';
import { Toaster } from 'sonner';
import { QueryProvider } from '@/components/providers/query-provider';
import { Logo } from '@/components/logo';
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
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ClerkProvider>
          <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-background/80 px-6 py-3 backdrop-blur">
            <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
              <Logo size={24} />
              <span className="font-serif text-xl">VoiceForge</span>
            </Link>
            <nav className="flex items-center gap-3 text-sm">
              <Show
                when="signed-out"
                fallback={
                  <>
                    <Link
                      href="/dashboard"
                      className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                    >
                      Dashboard
                    </Link>
                    <UserButton />
                  </>
                }
              >
                <SignInButton mode="modal">
                  <button className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
                    Sign in
                  </button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm">
                    Sign up
                  </button>
                </SignUpButton>
              </Show>
            </nav>
          </header>
          <QueryProvider>
            <main className="flex flex-1 flex-col">{children}</main>
          </QueryProvider>
          <Toaster richColors position="top-right" />
        </ClerkProvider>
      </body>
    </html>
  );
}
