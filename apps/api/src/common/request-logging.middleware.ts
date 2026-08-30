import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logging';
import { stripQuery } from './strip-query';

/**
 * Conservative shape for an inbound correlation ID: short, opaque, and free of
 * anything that could be interpreted downstream.
 *
 * The correlation ID reaches structured logs, the `X-Request-ID` response
 * header and PostHog error tracking, none of which should ever echo
 * caller-controlled free text. Rejecting the value outright and minting a
 * fresh one is safe here — an upstream proxy sending a conforming ID keeps
 * its trace, and anything else simply gets a server-owned ID instead.
 */
const CORRELATION_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Attaches a correlation ID (X-Request-ID) to every incoming request and logs
 * request/response lifecycle events with structured JSON output.
 *
 * - Reuses an existing X-Request-ID header when it is well-formed (supports
 *   upstream proxies).
 * - Generates a UUID v4 when the header is absent or does not conform.
 * - Emits pino JSON logs for: request start, response finish, and errors.
 * - Attaches correlation ID to response via X-Request-ID header.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Express collapses a repeated header into a comma-joined string, which the
    // pattern rejects, so a duplicated header also falls back to a fresh ID.
    const inbound = req.headers['x-request-id'];
    const correlationId =
      typeof inbound === 'string' && CORRELATION_ID_SHAPE.test(inbound) ? inbound : uuidv4();
    const start = Date.now();

    // Attach to request for downstream access
    ((req as unknown) as Record<string, unknown>).correlationId = correlationId;

    // Propagate correlation ID to response
    res.setHeader('X-Request-ID', correlationId);

    logger.info({
      msg: 'request:start',
      correlationId,
      method: req.method,
      url: stripQuery(req.originalUrl),
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
        url: stripQuery(req.originalUrl),
        statusCode: res.statusCode,
        durationMs,
      });
    });

    next();
  }
}
