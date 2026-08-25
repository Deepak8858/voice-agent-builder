/**
 * Shared response helpers for the k6 suites.
 *
 * The API wraps every successful response in an envelope
 * (`apps/api/src/common/response-envelope.interceptor.ts`):
 *
 *   { success: true, data: <payload>, error: null }
 *
 * and every error in `{ success: false, data: null, error: { code, message } }`
 * (`apps/api/src/common/http-exception.filter.ts`). The real client unwraps
 * `body.data` (`apps/web/lib/api.ts`), so a k6 check that reads `body.items` or
 * `body.checks` off the raw response is inspecting the envelope, not the
 * payload, and silently evaluates `undefined`.
 *
 * Only `/metrics` and handlers marked `@SkipResponseEnvelope()` are exempt, so
 * these helpers accept an unwrapped payload too and keep working if a probed
 * route is ever exempted.
 */

/**
 * The payload of an API response, or `null` when the body is not JSON.
 *
 * Never throws: a malformed body must fail the surrounding check rather than
 * abort the k6 iteration.
 */
export function apiData(res) {
  try {
    const parsed = JSON.parse(res.body);
    if (parsed === null || typeof parsed !== 'object') return null;
    // An envelope always carries `success`; anything else is already a payload.
    return 'success' in parsed ? parsed.data : parsed;
  } catch {
    return null;
  }
}

/**
 * The `items` array of a list response, or `null` when absent/malformed.
 * Callers can treat a `null` result as "no usable list".
 */
export function apiItems(res) {
  const data = apiData(res);
  return Array.isArray(data?.items) ? data.items : null;
}
