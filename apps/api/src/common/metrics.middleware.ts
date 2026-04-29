import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Middleware that records request duration and counts into Prometheus metrics.
 *
 * Uses the raw Express path (req.route?.path) so we get generic route labels
 * rather than per-URL paths with IDs — which prevents cardinality explosion.
 * Falls back to req.path for non-routed requests (e.g. /health).
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const route = (req as { route?: { path: string } }).route?.path ?? req.path;
    const labels = { method: req.method, route };

    this.metrics.httpActiveRequests.inc(labels);

    const start = performance.now();
    res.on('finish', () => {
      const duration = (performance.now() - start) / 1000;
      const statusCode = res.statusCode.toString();
      const recordLabels = { ...labels, status_code: statusCode };

      this.metrics.httpRequestsTotal.inc(recordLabels);
      this.metrics.httpRequestDuration.observe(labels, duration);
      this.metrics.httpActiveRequests.dec(labels);

      if (res.statusCode >= 400) {
        this.metrics.httpErrorsTotal.inc(recordLabels);
      }
    });

    next();
  }
}