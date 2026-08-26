import 'server-only';
import { buildPostHogCapture, type PostHogCaptureContext } from '@voiceforge/shared';
import { resolvePostHogHost } from './posthog-config';

/**
 * Server-side PostHog capture for Next.js route handlers.
 *
 * `posthog-node` is deliberately not used here. It buffers events and relies on
 * an explicit `shutdown()`/`flush()` to deliver them; a route handler has no
 * lifecycle hook to call one, so buffered events would be lost whenever the
 * server instance is recycled. A single awaited request is both simpler and
 * strictly more reliable for the handful of low-volume conversion events the
 * web tier emits. The API service, which is long-lived and has a shutdown hook,
 * keeps using the SDK.
 *
 * The privacy boundary is the same one the browser and the API use:
 * `buildPostHogCapture` validates the event against the closed contract, binds
 * identity per `EVENT_IDENTITY_KIND`, and returns `null` for anything unsafe.
 *
 * Nothing here throws. Analytics must never turn a successful onboarding into a
 * failed request.
 *
 * Unlike the browser, this module talks to PostHog directly rather than through
 * `/vf-relay`. The proxy exists to keep browser traffic same-origin; CSP and ad
 * blockers do not apply to a server-side fetch, and routing through the app's
 * own origin would only add a hop.
 */

/** Upper bound on the capture request. Latency beats event delivery. */
const CAPTURE_TIMEOUT_MS = 2_000;

interface ServerPostHogConfig {
  projectToken: string;
  host: string;
}

/**
 * Reads the server-side (non-`NEXT_PUBLIC_`) PostHog settings.
 *
 * Uses `POSTHOG_ENABLED` rather than the browser kill switch: this emitter runs
 * in the same trust domain as the API, and the two switches are independent by
 * design so browser capture can be disabled without losing server-side
 * conversion events.
 */
function serverConfig(): ServerPostHogConfig | null {
  if (process.env.POSTHOG_ENABLED !== 'true') return null;

  const projectToken = process.env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!projectToken) return null;

  // Same normalizer the browser settings and the proxy rewrites use, so there
  // is exactly one definition of a valid host. Never strict: a bad value must
  // degrade analytics, not fail an onboarding request.
  const host = resolvePostHogHost(process.env.POSTHOG_HOST, {
    strict: false,
    envVar: 'POSTHOG_HOST',
  });

  return { projectToken, host };
}

/**
 * The single transport for everything this module sends.
 *
 * Both public functions post the same envelope to the same endpoint under the
 * same timeout, so the endpoint, the abort handling and the swallow-and-clear
 * pattern live here once. Callers build only their own event name, distinct ID
 * and properties.
 *
 * Always resolves successfully.
 */
async function postCapture(
  config: ServerPostHogConfig,
  payload: {
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

  try {
    await fetch(`${config.host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      // Never let a capture keep a serverless invocation alive.
      keepalive: false,
      cache: 'no-store',
      body: JSON.stringify({
        api_key: config.projectToken,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    });
  } catch {
    // Timed out, aborted or network failure: analytics is best-effort.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one contract event. Resolves once the request settles or the timeout
 * elapses, and always resolves successfully.
 *
 * Callers must await this only after every write the event describes has
 * committed, so the event means "this happened" rather than "this was
 * attempted".
 */
export async function captureServerEvent(
  event: string,
  properties: Record<string, unknown> | null,
  context: PostHogCaptureContext,
): Promise<void> {
  const config = serverConfig();
  if (!config) return;

  const capture = buildPostHogCapture({ event, properties, context });
  if (!capture) return;

  await postCapture(config, {
    event: capture.event,
    distinct_id: capture.distinctId,
    properties: {
      ...capture.properties,
      $groups: capture.groups,
      ...(capture.processPersonProfile ? {} : { $process_person_profile: false }),
      // The server's egress IP is not the user's location.
      $geoip_disable: true,
    },
  });
}

/** Where in the Next.js server an exception surfaced. */
export interface ServerExceptionContext {
  /** Next.js error digest — the same value the browser boundary receives. */
  digest?: string | undefined;
  /** Route pattern (`/agents/[id]`), never the resolved path with real IDs. */
  routePath?: string | undefined;
  /** `render` or `route`, from the Next.js request-error context. */
  routeType?: string | undefined;
  /** `app-router` / `pages-router`, from the same context. */
  routerKind?: string | undefined;
}

/**
 * True when an error is a client-disconnect artifact rather than an application
 * bug.
 *
 * A reader that navigates away mid-render aborts the streaming render. Node then
 * tears down the render's `TransformStream` controller and clears its
 * algorithms; a later frame that still calls into that controller throws
 * `controller[kState].transformAlgorithm is not a function`, with a stack that
 * lives entirely in `node:internal/webstreams`. The same disconnect also
 * surfaces as a DOMException `AbortError` or a Next.js `ResponseAborted`. None
 * of these is fixable in application code, so reporting them only adds triage
 * noise to the issue list.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const name = String((error as { name?: unknown }).name ?? '');
  if (name === 'AbortError' || name === 'ResponseAborted') return true;

  const message = String((error as { message?: unknown }).message ?? '');
  const stack = String((error as { stack?: unknown }).stack ?? '');

  // A stream controller algorithm called after the controller was cleared on
  // abort. The message alone is broad, so it must also come from Node's stream
  // internals to count as a disconnect artifact.
  const clearedAlgorithm =
    /\b(transform|flush|write|close|pull|cancel)Algorithm is not a function\b/.test(message);

  return clearedAlgorithm && stack.includes('node:internal/webstreams');
}

/** A single frame in PostHog's manual-capture `raw` stacktrace format. */
interface RawStackFrame {
  /** Must be the literal `custom` for manually constructed frames. */
  platform: 'custom';
  lang: 'javascript';
  function: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

/** `at fn (/path/file.js:1:2)` or the bare `at /path/file.js:1:2` form. */
const STACK_FRAME_SHAPE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Parses `err.stack` into the frame list PostHog's ingestion expects.
 *
 * Manual `$exception` capture requires `stacktrace: { type: 'raw', frames }`;
 * an unrecognised property carrying the stack as a string is dropped by the
 * strict event schema, which would leave every server issue with no stack at
 * all. Parsing here rather than pulling in `posthog-node` keeps this module
 * dependency-free — see the note at the top of the file on why that SDK is not
 * used in this tier.
 *
 * Frames are reversed because V8 prints innermost-first while PostHog's raw
 * format expects the crashing frame last. Unparseable lines are skipped rather
 * than guessed at: a partial stack still groups and symbolicates, while a
 * malformed frame risks the whole event being rejected.
 */
function parseStackFrames(stack: string | undefined): RawStackFrame[] {
  if (!stack) return [];

  const frames: RawStackFrame[] = [];

  for (const line of stack.split('\n')) {
    const match = STACK_FRAME_SHAPE.exec(line);
    if (!match) continue;

    const [, fn, filename, lineno, colno] = match;
    if (!filename) continue;

    frames.push({
      platform: 'custom',
      lang: 'javascript',
      function: fn ?? '<anonymous>',
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      // Node internals and dependencies are not this application's code, and
      // marking them keeps them out of the issue's suspect frame.
      in_app: !filename.startsWith('node:') && !filename.includes('node_modules'),
    });
  }

  return frames.reverse();
}

/**
 * Reports an uncaught server-side exception to PostHog error tracking.
 *
 * This does not go through `buildPostHogCapture`: that helper enforces the
 * closed Phase 1 *conversion event* contract and returns `null` for anything
 * outside it, which would drop every exception. The privacy properties it
 * guarantees are reproduced explicitly below instead — no person profile, no
 * geo-IP, and no request body, headers or user identifiers are attached.
 *
 * Always resolves successfully. An exception handler that can itself throw
 * would turn a single failed request into an unhandled rejection.
 */
export async function captureServerException(
  error: unknown,
  context: ServerExceptionContext = {},
): Promise<void> {
  const config = serverConfig();
  if (!config) return;

  // A client disconnect during a streaming render is not an application bug.
  if (isAbortError(error)) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const frames = parseStackFrames(err.stack);

  await postCapture(config, {
    event: '$exception',
    // Opaque, non-person distinct ID: the digest correlates this event with
    // the browser-side report of the same failure, and the fallback keeps
    // the event attributable to the server rather than to a visitor.
    distinct_id: context.digest ?? 'web-server',
    properties: {
      $exception_list: [
        {
          type: err.name || 'Error',
          value: err.message,
          mechanism: { handled: false, synthetic: false },
          ...(frames.length > 0 ? { stacktrace: { type: 'raw', frames } } : {}),
        },
      ],
      ...(context.digest ? { error_digest: context.digest } : {}),
      ...(context.routePath ? { route_path: context.routePath } : {}),
      ...(context.routeType ? { route_type: context.routeType } : {}),
      ...(context.routerKind ? { router_kind: context.routerKind } : {}),
      error_boundary: 'server',
      $process_person_profile: false,
      $geoip_disable: true,
    },
  });
}
