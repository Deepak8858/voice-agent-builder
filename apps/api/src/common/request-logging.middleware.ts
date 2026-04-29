import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logging';

/**
 * Attaches a correlation ID (X-Request-ID) to every incoming request and logs
 * request/response lifecycle events with structured JSON output.
 *
 * - Reads existing X-Request-ID header if present (supports upstream proxies).
 * - Generates a UUID v4 when no header is provided.
 * - Emits pino JSON logs for: request start, response finish, and errors.
 * - Attaches correlation ID to response via X-Request-ID header.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const correlationId = (req.headers['x-request-id'] as string) || uuidv4();
    const start = Date.now();

    // Attach to request for downstream access
    ((req as unknown) as Record<string, unknown>).correlationId = correlationId;

    // Propagate correlation ID to response
    res.setHeader('X-Request-ID', correlationId);

    logger.info({
      msg: 'request:start',
      correlationId,
      method: req.method,
      url: req.originalUrl,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    // Log on response finish
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      logger.info({
        msg: 'request:end',
        correlationId,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
      });
    });

    next();
  }
}
