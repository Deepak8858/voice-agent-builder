import { z } from 'zod';
import { RuntimeUsageDecisionSchema, type RuntimeUsageDecision, type RuntimeUsageEvent } from '@voiceforge/shared';

/**
 * The API wraps every response in a success envelope, so the decision is one
 * level down. Parsing it here means a shape change is caught at the boundary
 * rather than producing an undefined `allowed` that reads as "keep going".
 */
const RuntimeUsageResponseSchema = z.object({
  success: z.literal(true),
  data: RuntimeUsageDecisionSchema,
});

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;

export type RuntimeUsageEmitter = (event: RuntimeUsageEvent) => Promise<RuntimeUsageDecision>;

export interface RuntimeUsageClientConfig {
  apiBaseUrl: string;
  internalApiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Authenticated metering transport.
 *
 * Uses the same internal-key configuration as knowledge retrieval, because the
 * usage endpoint sits behind the same guard. Every event carries a stable
 * `eventId`, so retrying a request the API already processed replays the
 * original decision instead of charging twice — which is what makes retrying
 * on a network failure safe.
 */
export function createRuntimeUsageClient(config: RuntimeUsageClientConfig): RuntimeUsageEmitter {
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(config.attempts ?? DEFAULT_ATTEMPTS, 1);
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (event) => {
    let lastError: Error = new Error('Runtime usage request was never attempted.');

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${baseUrl}/api/v1/internal/runtime/usage/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-key': config.internalApiKey,
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`Runtime usage API returned ${response.status}.`);
        }
        return RuntimeUsageResponseSchema.parse(await response.json()).data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < attempts) await sleep(retryBaseMs * attempt);
      }
    }

    throw lastError;
  };
}

export interface CallMeterConfig {
  callId: string;
  organizationId: string;
  emit: RuntimeUsageEmitter;
  /**
   * Hangs the call up. Invoked when billing refuses a minute, and when metering
   * has been unreachable for long enough that the call can no longer be proven
   * to be paid for.
   */
  terminate: (reason: string) => Promise<void> | void;
  minuteIntervalMs?: number;
  /** Unreported minute boundaries tolerated before the call is terminated. */
  maxConsecutiveFailures?: number;
  now?: () => Date;
  logger?: Pick<Console, 'warn' | 'error'>;
}

const MINUTE_MS = 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2;

/**
 * Per-call metering lifecycle.
 *
 * The runtime is the only component that knows a call is still up, so it is the
 * only component that can report the minute boundaries usage is billed on. Two
 * rules hold here:
 *
 * - a refused minute ends the call, otherwise an organization with no credit
 *   talks for as long as it likes;
 * - metering that cannot be reached is treated as a refusal after a small
 *   number of consecutive failures, so an outage on our side cannot be used as
 *   free unlimited calling.
 *
 * Event IDs are derived from the call ID and the minute number, never from a
 * clock or a random value, so a retried request is recognised as a replay.
 */
export class CallMeter {
  private readonly minuteIntervalMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private minute = 1;
  private consecutiveFailures = 0;
  private connectedAt: Date | null = null;
  private settled = false;

  constructor(private readonly config: CallMeterConfig) {
    this.minuteIntervalMs = config.minuteIntervalMs ?? MINUTE_MS;
    this.maxConsecutiveFailures = Math.max(
      config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      1,
    );
    this.now = config.now ?? (() => new Date());
    this.logger = config.logger ?? console;
  }

  /**
   * Reports the connection and commits the minute reserved at admission. A
   * denial here means the reservation could not be committed, so the call is
   * not allowed to proceed.
   */
  async connected(providerCallId: string): Promise<void> {
    this.connectedAt = this.now();
    try {
      const decision = await this.config.emit({
        type: 'call_connected',
        eventId: `${this.config.callId}:connected`,
        callId: this.config.callId,
        organizationId: this.config.organizationId,
        occurredAt: this.connectedAt.toISOString(),
        providerCallId,
      });
      if (!decision.allowed) {
        await this.terminate(decision.reason);
      }
    } catch (err) {
      this.logger.error(
        `[metering] call ${this.config.callId} could not report connection: ${(err as Error).message}`,
      );
      await this.terminate('metering_unavailable');
    }
  }

  /** Begins charging for every subsequent minute. */
  start(): void {
    if (this.timer || this.settled) return;
    this.timer = setInterval(() => {
      void this.reportMinuteBoundary();
    }, this.minuteIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for direct invocation in tests; normally driven by `start()`. */
  async reportMinuteBoundary(): Promise<void> {
    if (this.settled) return;
    this.minute += 1;
    const minute = this.minute;

    try {
      const decision = await this.config.emit({
        type: 'minute_boundary',
        eventId: `${this.config.callId}:minute:${minute}`,
        callId: this.config.callId,
        organizationId: this.config.organizationId,
        occurredAt: this.now().toISOString(),
        minute,
      });
      this.consecutiveFailures = 0;
      if (!decision.allowed) {
        await this.terminate(decision.reason);
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      this.logger.warn(
        `[metering] call ${this.config.callId} minute ${minute} unreported ` +
          `(${this.consecutiveFailures}/${this.maxConsecutiveFailures}): ${(err as Error).message}`,
      );
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        await this.terminate('metering_unavailable');
      }
    }
  }

  /**
   * Final report for a call that connected. Runs once: the shutdown callback
   * and an explicit end must not both close the same call.
   */
  async ended(durationSeconds?: number): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stop();

    const seconds = durationSeconds ?? this.elapsedSeconds();
    try {
      await this.config.emit({
        type: 'call_ended',
        eventId: `${this.config.callId}:ended`,
        callId: this.config.callId,
        organizationId: this.config.organizationId,
        occurredAt: this.now().toISOString(),
        durationSeconds: seconds,
      });
    } catch (err) {
      // Reconciliation finalizes calls that never reported an end, so a lost
      // final report delays settlement rather than losing it.
      this.logger.error(
        `[metering] call ${this.config.callId} could not report end: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Reports a call that never became billable. The API compensates the
   * reservation and frees the concurrency slot, so this must be attempted even
   * when the runtime is already failing.
   */
  async failed(failureCode: string): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stop();

    try {
      await this.config.emit({
        type: 'call_failed',
        eventId: `${this.config.callId}:failed`,
        callId: this.config.callId,
        organizationId: this.config.organizationId,
        occurredAt: this.now().toISOString(),
        failureCode,
      });
    } catch (err) {
      this.logger.error(
        `[metering] call ${this.config.callId} could not report failure: ${(err as Error).message}`,
      );
    }
  }

  private async terminate(reason: string): Promise<void> {
    this.stop();
    try {
      await this.config.terminate(reason);
    } catch (err) {
      this.logger.error(
        `[metering] call ${this.config.callId} could not be terminated after ${reason}: ${(err as Error).message}`,
      );
    }
  }

  private elapsedSeconds(): number {
    if (!this.connectedAt) return 0;
    return Math.max(Math.floor((this.now().getTime() - this.connectedAt.getTime()) / 1_000), 0);
  }
}
