import { Injectable, Logger } from '@nestjs/common';
import {
  buildPostHogCapture,
  type PostHogCaptureContext,
  type PostHogEventName,
  type PostHogEventProperties,
} from '@voiceforge/shared';
import { PostHog } from 'posthog-node';
import type { PostHogConfig } from './posthog.config';

/**
 * The closed set of events this service will send, as a discriminated union of
 * `{ event, properties }` pairs. Callers cannot pass an arbitrary event name or
 * an arbitrary property bag: both are pinned to the Phase 1 contract in
 * `@voiceforge/shared`.
 */
export type TypedPostHogEvent = {
  [K in PostHogEventName]: { event: K; properties: PostHogEventProperties[K] };
}[PostHogEventName];

/**
 * Tenant/actor context resolved server-side. `organizationId` must come from
 * `prisma.organizationIdFor(workspaceId)` — never from a client, and
 * `eventScopeId` is the per-event opaque ID (call ID, or compliance check ID
 * for a pre-call block) used as the non-person distinct ID.
 */
export type { PostHogCaptureContext };

/** The slice of `posthog-node` this service depends on. */
export interface PostHogClientLike {
  capture(message: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
    disableGeoip?: boolean;
  }): void;
  captureException(
    error: unknown,
    distinctId?: string,
    additionalProperties?: Record<string, unknown>,
  ): void;
  register(properties: Record<string, unknown>): Promise<void> | void;
  shutdown(shutdownTimeoutMs?: number): Promise<void> | void;
}

export type PostHogClientFactory = (config: PostHogConfig) => PostHogClientLike;

/** Upper bound on the shutdown flush. Shutdown latency beats event delivery. */
const SHUTDOWN_TIMEOUT_MS = 2_000;

const defaultClientFactory: PostHogClientFactory = (config) =>
  new PostHog(config.projectToken, {
    host: config.host,
    // Never let PostHog infer location from the API server's egress IP.
    disableGeoip: true,
  });

/**
 * Best-effort product analytics. Three invariants hold at all times:
 *
 *  1. When PostHog is disabled or unconfigured no client is constructed and
 *     every method is a no-op.
 *  2. `capture` never throws and never awaits network I/O, so it can be called
 *     from the call path without affecting latency or correctness.
 *  3. Nothing reaches the wire without passing `buildPostHogCapture`, which is
 *     the privacy boundary and also binds identity and groups to the event.
 *     A `null` result means "drop silently".
 */
@Injectable()
export class PostHogService {
  private readonly logger = new Logger(PostHogService.name);
  private readonly client: PostHogClientLike | null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    config: PostHogConfig | null,
    clientFactory: PostHogClientFactory = defaultClientFactory,
  ) {
    if (!config) {
      this.client = null;
      return;
    }
    let client: PostHogClientLike | null = null;
    try {
      client = clientFactory(config);
      // Super properties carry release metadata only — never user data.
      void Promise.resolve(
        client.register({
          environment: config.environment,
          release: config.release,
        }),
      ).catch(() => {});
    } catch (err) {
      client = null;
      this.logger.debug(`[posthog.init] ${(err as Error).message}`);
    }
    this.client = client;
  }

  /** True only when a client was actually constructed. */
  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Sanitize and enqueue an event. Returns nothing and swallows every failure:
   * analytics must never surface an error to a caller.
   */
  capture(event: TypedPostHogEvent, context: PostHogCaptureContext): void {
    const client = this.client;
    if (!client) return;

    try {
      // Identity, groups and sanitization are all decided by the shared
      // contract; a null result means the event is not safe to send.
      const capture = buildPostHogCapture({
        event: event.event,
        properties: event.properties as Record<string, unknown>,
        context,
      });
      if (!capture) return;

      client.capture({
        distinctId: capture.distinctId,
        event: capture.event,
        properties: {
          ...capture.properties,
          // Autonomous call events must never create a person profile.
          ...(capture.processPersonProfile
            ? {}
            : { $process_person_profile: false }),
        },
        groups: capture.groups,
        disableGeoip: true,
      });
    } catch (err) {
      this.logger.debug(`[posthog.capture:${event.event}] ${(err as Error).message}`);
    }
  }

  /**
   * Best-effort error tracking for unexpected server failures.
   *
   * Exceptions never create a person profile: the distinct ID is an opaque
   * correlation ID (or a fixed server identity), and
   * `$process_person_profile: false` is always set. Only the error itself is
   * sent — no request bodies, headers or user identifiers — because exception
   * messages already risk embedding operational values. Never throws.
   */
  captureException(error: unknown, correlationId?: string): void {
    const client = this.client;
    if (!client) return;
    try {
      const err = error instanceof Error ? error : new Error(String(error));
      client.captureException(err, correlationId ?? 'api-server', {
        $process_person_profile: false,
      });
    } catch (err) {
      this.logger.debug(`[posthog.captureException] ${(err as Error).message}`);
    }
  }

  /**
   * Flushes pending events. Safe to call when disabled, idempotent, and never
   * throws — it is invoked from the application shutdown hook.
   *
   * The flush is bounded twice over: the SDK is given its own timeout, and the
   * await races a local timer. Without the outer race an SDK whose promise
   * never settles (a hung socket during a network partition) would block
   * `onApplicationShutdown` indefinitely and prevent the process from exiting.
   * Losing a few buffered analytics events is always preferable to a stuck
   * deployment.
   */
  async shutdown(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve(client.shutdown(SHUTDOWN_TIMEOUT_MS)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
            // Do not hold the event loop open for the sake of the guard timer.
            timer.unref?.();
          }),
        ]);
      } catch (err) {
        this.logger.debug(`[posthog.shutdown] ${(err as Error).message}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.shutdownPromise;
  }
}
