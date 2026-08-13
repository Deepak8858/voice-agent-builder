'use client';

import { useEffect } from 'react';
import { captureClientException } from '@/lib/analytics/posthog';

/**
 * Root-layout error boundary — the last line of defence.
 *
 * `error.tsx` is rendered *inside* the root layout, so it cannot catch a
 * failure in the layout itself. When that happens Next.js discards the whole
 * tree and renders this file instead, which is why it has to supply its own
 * `<html>` and `<body>`.
 *
 * That also means none of the app's styling is available: `globals.css` and the
 * font variables are applied by the root layout that just failed. The styles
 * here are inline and self-contained on purpose — a stylesheet-dependent
 * fallback would render unstyled in exactly the situation it exists for. The
 * palette mirrors the app's dark surface so this does not flash as a white
 * page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureClientException(error, { digest: error.digest, boundary: 'global' });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4rem 1.5rem',
          textAlign: 'center',
          backgroundColor: '#0a0a0a',
          color: '#fafafa',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: '0.75rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: '#a1a1aa',
          }}
        >
          Error
        </p>
        <h1 style={{ margin: '0.75rem 0 0', fontSize: '1.875rem', letterSpacing: '-0.025em' }}>
          Something went wrong
        </h1>
        <p
          style={{
            margin: '0.75rem 0 0',
            maxWidth: '28rem',
            fontSize: '0.875rem',
            lineHeight: 1.6,
            color: '#a1a1aa',
          }}
        >
          The application hit an unexpected error and could not continue.
        </p>

        {error.message ? (
          <p
            style={{
              margin: '1rem 0 0',
              maxWidth: '28rem',
              overflowWrap: 'break-word',
              borderRadius: '0.375rem',
              border: '1px solid #27272a',
              backgroundColor: '#18181b',
              padding: '0.5rem 0.75rem',
              textAlign: 'left',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: '0.75rem',
              lineHeight: 1.5,
              color: '#a1a1aa',
            }}
          >
            {error.message}
          </p>
        ) : null}
        {error.digest ? (
          <p
            style={{
              margin: '0.5rem 0 0',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: '0.75rem',
              color: '#a1a1aa',
            }}
          >
            Reference: {error.digest}
          </p>
        ) : null}

        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: '1.5rem',
            height: '2.5rem',
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: '0.375rem',
            border: 'none',
            backgroundColor: '#fafafa',
            color: '#0a0a0a',
            padding: '0 1rem',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
