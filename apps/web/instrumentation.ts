import type { Instrumentation } from 'next';

/**
 * Server instrumentation hook.
 *
 * `instrumentation-client.ts` is the browser half of this pair and covers only
 * what happens in the browser. Everything that fails on the server — a throwing
 * Server Component, a route handler, a server action — is caught by Next.js and
 * turned into a digest before any client-side handler can see it, so without
 * this hook those errors exist solely in the container's stdout.
 *
 * `register()` is required for Next.js to load the file at all; it stays empty
 * because there is nothing to initialise. `posthog-node` is deliberately not
 * started here — see `lib/analytics/posthog-server.ts` for why buffering
 * without a reliable flush is the wrong trade in this tier.
 */
export function register(): void {
  // No server-side SDK to initialise: captures are direct, awaited requests.
}

/**
 * Reports every uncaught server-side error to PostHog.
 *
 * The import is dynamic and lives inside the handler because this module is
 * evaluated in both the `nodejs` and `edge` runtimes, while `posthog-server.ts`
 * is `server-only` and reads `process.env`. Importing it at module scope would
 * pull it into the edge bundle even for requests that never fail.
 *
 * `request` is intentionally ignored. It carries headers, cookies and the
 * resolved URL — session tokens and customer identifiers — and none of it is
 * needed to fix a server error. `context.routePath` gives the route *pattern*,
 * which localises the bug without leaking the IDs in the real path.
 *
 * Awaiting matters: the capture is a single fetch and Next.js will not keep the
 * invocation alive past this handler returning, so a fire-and-forget call would
 * be dropped whenever the instance is recycled straight after the failure.
 * Nothing here throws — `captureServerException` swallows its own failures.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  _request,
  context,
) => {
  const { captureServerException } = await import('@/lib/analytics/posthog-server');

  const digest =
    typeof error === 'object' && error !== null && 'digest' in error
      ? String((error as { digest?: unknown }).digest ?? '') || undefined
      : undefined;

  await captureServerException(error, {
    digest,
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
  });
};
