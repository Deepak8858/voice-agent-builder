/**
 * Retry-with-backoff for outbound HTTP calls made during live voice calls.
 *
 * Only transient failures are retried: HTTP 429, HTTP 5xx, and
 * timeouts/network errors. Client errors (400, 401, 403, ...) are returned
 * immediately — retrying them wastes the caller's (very tight) latency budget
 * and can never succeed.
 */

export interface RetryOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  /** Base backoff delay; attempt n waits `baseDelayMs * n`. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Runs `fn` until it returns a non-retryable Response or attempts run out.
 * Thrown errors (timeouts, socket resets) count as transient and are retried;
 * the last error is rethrown once the attempt budget is exhausted.
 */
export async function fetchWithRetry(
  fn: () => Promise<Response>,
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(options.attempts ?? DEFAULT_ATTEMPTS, 1);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: Error = new Error('Request was never attempted.');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fn();
      if (!isRetryableStatus(response.status) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`Upstream returned ${response.status}.`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === attempts) throw lastError;
    }
    if (attempt < attempts && baseDelayMs > 0) {
      await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError;
}
