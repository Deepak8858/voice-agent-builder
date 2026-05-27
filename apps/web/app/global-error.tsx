'use client';

import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
          <section className="w-full max-w-lg rounded-3xl border border-border bg-card p-8 text-center shadow-xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
              Application error
            </p>
            <h1 className="mt-3 font-[family-name:var(--font-serif)] text-3xl tracking-tight">
              Something went wrong
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The dashboard hit an unexpected error. Try again, or reload the page if the problem persists.
            </p>
            {error.digest ? (
              <p className="mt-4 rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                Error digest: {error.digest}
              </p>
            ) : null}
            <div className="mt-6 flex justify-center">
              <Button type="button" onClick={reset}>
                Try again
              </Button>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
