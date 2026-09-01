import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { logger } from '../logging';
import { stripQuery } from './strip-query';
import { env, isProduction } from '../config/env';
import type { ApiError, ApiErrorCode } from '@voiceforge/shared';
import type { PostHogService } from '../posthog/posthog.service';

/**
 * Global exception filter — translates all thrown exceptions into the shared envelope:
 *   { success: false, data: null, error: { code, message, details? } }
 *
 * Uses pino structured logging with request correlation ID when available.
 *
 * Every exception that reaches this filter is also mirrored to PostHog error
 * tracking when analytics is enabled — including `HttpException`s and thrown
 * non-`Error` values, which previously fell through the reporting path
 * entirely. That gap meant a route deliberately throwing
 * `new InternalServerErrorException(...)` returned a 500 to the caller and left
 * no trace in error tracking. Which statuses qualify is decided by
 * `shouldCapture`; the mirror is best-effort and the response envelope never
 * depends on it.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly posthog?: PostHogService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const correlationId = ((req as unknown) as Record<string, unknown>).correlationId as string | undefined;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let loggedWithStack = false;
    let error: ApiError = {
      code: 'INTERNAL_ERROR' as ApiErrorCode,
      message: 'Unexpected server error.',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        error = { code: 'INTERNAL_ERROR' as ApiErrorCode, message: resp };
      } else if (
        resp &&
        typeof resp === 'object' &&
        'code' in resp &&
        typeof ((resp as unknown) as Record<string, unknown>).code === 'string'
      ) {
        const obj = resp as { code: ApiErrorCode; message?: string; details?: Record<string, unknown> };
        // Details are stripped in production to avoid leaking internals, with
        // one exception: rate-limit responses carry retryAfterSeconds, which
        // clients need to show the wait time.
        const keepDetails = !isProduction() || obj.code === 'RATE_LIMITED';
        error = {
          code: obj.code,
          message: obj.message ?? exception.message,
          details: keepDetails ? obj.details : undefined,
        };
      } else if (resp && typeof resp === 'object' && 'message' in resp) {
        error = {
          code: this.mapStatus(status),
          message: String((resp as { message: unknown }).message),
        };
      }
    } else if (exception instanceof Error) {
      // This record carries the stack; the 5xx summary below is skipped for
      // this branch so each exception produces exactly one error record.
      logger.error(
        { err: exception, correlationId, method: req.method, url: stripQuery(req.url), status },
        exception.message,
      );
      loggedWithStack = true;
      error.message = isProduction()
        ? 'Unexpected server error.'
        : exception.message;
      // The production message is a constant, so keep the correlation id on the
      // response: it traces a masked 500 back to its log line and is already
      // public in the `X-Request-ID` header. The error class is withheld in
      // production — it names internal machinery (`PrismaClientKnownRequestError`
      // and friends) and is exactly what the masked message exists to hide.
      // Error tracking still receives the real exception, so the per-fault
      // fingerprint is not lost.
      error.details = {
        ...(isProduction() ? {} : { errorClass: exception.name }),
        ...(correlationId ? { correlationId } : {}),
      };
    } else {
      logger.error({ correlationId, method: req.method, url: stripQuery(req.url) }, 'Unhandled non-Error exception');
      error.details = correlationId ? { correlationId } : undefined;
    }

    // Warn on 5xx — these are bugs, not client errors. The real exception
    // message is logged even when the response body masks it: an HttpException
    // (AppError included) skips the `instanceof Error` log branch above, and a
    // production 502 with no recorded cause is undiagnosable after the fact.
    if (status >= 500 && !loggedWithStack) {
      logger.error(
        {
          correlationId,
          method: req.method,
          url: stripQuery(req.url),
          status,
          code: error.code,
          cause: exception instanceof Error ? exception.message : String(exception),
        },
        'HTTP 5xx response',
      );
    }

    if (this.shouldCapture(status)) {
      // Route *pattern* (`/agents/:id`), not `req.url`: the resolved path
      // embeds tenant and resource IDs, and the pattern is what identifies the
      // faulting handler. Undefined when the failure happened before routing
      // resolved, which is itself the useful signal in that case.
      const route = ((req as unknown) as { route?: { path?: unknown } }).route?.path;

      this.posthog?.captureException(exception, correlationId, {
        status_code: status,
        error_code: error.code,
        http_method: req.method,
        ...(typeof route === 'string' ? { route_path: route } : {}),
      });
    }

    // A 429 must carry the standard `Retry-After` header, not only the JSON
    // hint: HTTP clients, proxies and SDK backoff logic read the header and
    // never look inside `error.details`. Delay-seconds form per RFC 9110.
    // Details survive production stripping for exactly this code (see
    // `keepDetails`), so the header fires in production too. A missing or
    // non-positive value emits no header rather than `Retry-After: NaN`.
    const retryAfter = error.code === 'RATE_LIMITED' ? error.details?.retryAfterSeconds : undefined;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      // Capped at one year: delay-seconds is 1*DIGIT, and String() renders
      // numbers >= 1e21 in exponential notation, which no real window needs.
      res.setHeader('Retry-After', String(Math.min(Math.ceil(retryAfter), 31_536_000)));
    }

    res.status(status).json({ success: false, data: null, error });
  }

  /**
   * Decides whether a response status is worth reporting to error tracking.
   *
   * 5xx is unconditional: every one is a server fault by definition.
   *
   * 4xx is gated on `POSTHOG_CAPTURE_CLIENT_ERRORS` and off by default. A 401
   * fires on every request in flight when a session expires, and 404s arrive
   * continuously from route probing — capturing them by default would bury
   * genuine faults under traffic that is working as designed. The flag exists
   * so that visibility can be turned on while debugging a client integration
   * and turned off again without a redeploy.
   *
   * Below 400 nothing is captured; a filter reached on a success status is not
   * a reportable condition.
   */
  private shouldCapture(status: number): boolean {
    if (status >= 500) return true;
    if (status >= 400) return env.POSTHOG_CAPTURE_CLIENT_ERRORS;
    return false;
  }

  private mapStatus(status: number): ApiErrorCode {
    switch (status) {
      case 400:
        return 'VALIDATION_ERROR';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 429:
        return 'RATE_LIMITED';
      case 501:
        return 'NOT_IMPLEMENTED';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
