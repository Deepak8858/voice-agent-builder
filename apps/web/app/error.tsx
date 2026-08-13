'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { captureClientException } from '@/lib/analytics/posthog';

/**
 * Route-level error boundary.
 *
 * This file is what makes React render failures visible to error tracking.
 * `posthog-js` autocapture only listens for `window.onerror` and
 * `unhandledrejection`; an error thrown during render never reaches either,
 * because React catches it and hands it to the nearest boundary. Without a
 * boundary that reports, every render crash is silently swallowed — the user
 * sees a broken page and error tracking stays empty.
 *
 * `global-error.tsx` is the sibling of this file and covers the case this one
 * cannot: a failure in the root layout itself, which happens above this
 * boundary.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Reported before paint so the error survives the user immediately
    // navigating away or closing the tab. `digest` is the opaque hash Next.js
    // also writes to the server log, and is the only way to tie this event to
    // the corresponding server-side stack.
    captureClientException(error, { digest: error.digest, boundary: 'route' });
  }, [error]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">Error</p>
      <h1 className="mt-3 font-[family-name:var(--font-serif)] text-3xl tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
        This page hit an unexpected error. You can retry, or head back to the dashboard.
      </p>

      {/*
        Next.js replaces the message of a server-side error with a generic
        string in production builds and exposes only `digest`, so this renders
        whatever the runtime considered safe to send to the browser rather than
        widening what is disclosed.
      */}
      {error.message ? (
        <p className="mt-4 max-w-md break-words rounded-md border border-border bg-muted/40 px-3 py-2 text-left font-[family-name:var(--font-mono)] text-xs leading-5 text-muted-foreground">
          {error.message}
        </p>
      ) : null}
      {error.digest ? (
        <p className="mt-2 font-[family-name:var(--font-mono)] text-xs text-muted-foreground">
          Reference: {error.digest}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
