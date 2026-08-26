import Link from 'next/link';

/**
 * Shared chrome for the public policy pages (`/refund`, `/support`,
 * `/services`, `/privacypolicy`, `/legal/dpa`).
 *
 * These pages exist to satisfy payment-processor review as well as to inform
 * customers, so they are deliberately plain, server-rendered, and free of
 * client-side state: a reviewer with JavaScript disabled must still be able to
 * read every commitment we make.
 */
export function LegalPage({
  title,
  lastUpdated,
  intro,
  children,
}: {
  title: string;
  lastUpdated: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-[family-name:var(--font-serif)] text-4xl">{title}</h1>
      <p className="mt-4 text-sm text-muted-foreground">Last updated: {lastUpdated}</p>
      {intro ? <div className="mt-6 text-sm leading-relaxed text-muted-foreground">{intro}</div> : null}

      <div className="mt-8 space-y-8">{children}</div>

      <LegalFooterNav />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

/** Cross-links so a reviewer can reach every policy from any single page. */
export function LegalFooterNav() {
  return (
    <nav className="mt-12 flex flex-wrap gap-x-5 gap-y-2 border-t pt-6 text-sm text-muted-foreground">
      <Link href="/" className="transition hover:text-foreground">
        Home
      </Link>
      <Link href="/services" className="transition hover:text-foreground">
        Services
      </Link>
      <Link href="/pricing" className="transition hover:text-foreground">
        Pricing
      </Link>
      <Link href="/refund" className="transition hover:text-foreground">
        Refund policy
      </Link>
      <Link href="/privacypolicy" className="transition hover:text-foreground">
        Privacy policy
      </Link>
      <Link href="/legal/dpa" className="transition hover:text-foreground">
        Data processing
      </Link>
      <Link href="/support" className="transition hover:text-foreground">
        Support
      </Link>
    </nav>
  );
}

export const SUPPORT_EMAIL = 'support@incfrog.ai';
export const BUSINESS_LOCATION = 'India';
