import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiError, ApiErrorCode } from '@voiceforge/shared';

/**
 * Catches ALL thrown exceptions and translates them into the shared envelope:
 *   { success: false, data: null, error: { code, message, details? } }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

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
        typeof (resp as Record<string, unknown>).code === 'string'
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
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
      error.message = exception.message;
    } else {
      this.logger.error(`Unhandled non-Error exception at ${req.method} ${req.url}`);
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
