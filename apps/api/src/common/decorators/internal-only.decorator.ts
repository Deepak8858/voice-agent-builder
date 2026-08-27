import { SetMetadata } from '@nestjs/common';

export const IS_INTERNAL_ONLY_KEY = 'isInternalOnly';

/**
 * Declares that a route may only be called by our own backend components
 * (the LiveKit agent, workers), never on behalf of an end user.
 *
 * `x-internal-key` alone does not express this. The Next.js proxy at
 * `apps/web/app/api/proxy/[...path]/route.ts` forwards every path a browser
 * asks for and attaches the server-side `INTERNAL_API_KEY` itself, so any
 * signed-in user can reach an `internal/` route through it. For metering that
 * is a money bug: a user could POST a forged `call_ended` or `call_failed` for
 * one of their own live calls and have the reserved minute refunded and the
 * concurrency lease dropped while the call is still up.
 *
 * The distinguishing signal is the user context, not the path. Our runtime
 * sends only `x-internal-key`; the proxy always sends an `authorization`
 * bearer token as well, because it exists to act as a user. `InternalAuthGuard`
 * therefore refuses an internal-only route whenever user context is present.
 * That closes the browser path without the runtime having to change and
 * without depending on the proxy to maintain a denylist.
 */
export const InternalOnly = () => SetMetadata(IS_INTERNAL_ONLY_KEY, true);
