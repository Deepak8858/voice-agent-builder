import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { logger } from '../logging';
import { isProduction } from '../config/env';
import type { ApiError, ApiErrorCode } from '@voiceforge/shared';

/**
 * Global exception filter — translates all thrown exceptions into the shared envelope:
 *   { success: false, data: null, error: { code, message, details? } }
 *
 * Uses pino structured logging with request correlation ID when available.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const correlationId = ((req as unknown) as Record<string, unknown>).correlationId as string | undefined;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
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
        error = {
          code: obj.code,
          message: obj.message ?? exception.message,
          details: obj.details,
        };
      } else if (resp && typeof resp === 'object' && 'message' in resp) {
        error = {
          code: this.mapStatus(status),
          message: String((resp as { message: unknown }).message),
        };
      }
    } else if (exception instanceof Error) {
      logger.error({ err: exception, correlationId, method: req.method, url: req.url }, exception.message);
      error.message = isProduction()
        ? 'Unexpected server error.'
        : exception.message;
    } else {
      logger.error({ correlationId, method: req.method, url: req.url }, 'Unhandled non-Error exception');
    }

    // Warn on 5xx — these are bugs, not client errors
    if (status >= 500) {
      logger.error({ correlationId, method: req.method, url: req.url, status }, 'HTTP 5xx response');
    }

    res.status(status).json({ success: false, data: null, error });
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
