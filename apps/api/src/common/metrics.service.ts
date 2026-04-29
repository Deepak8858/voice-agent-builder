import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics for VoiceForge API.
 *
 * Exposed at GET /api/v1/metrics (see MetricsController).
 * Metrics collected:
 *   - http_requests_total{method, route, status_code}  — total request count
 *   - http_request_duration_seconds{method, route}    — request latency histogram
 *   - http_active_requests{method, route}             — currently-in-flight requests (gauge)
 *   - http_errors_total{method, route, status_code}  — error-only counter
 *
 * Histogram buckets tuned for API latency (ms):
 *   5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  static readonly REGISTRY = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [MetricsService.REGISTRY],
  });

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [MetricsService.REGISTRY],
  });

  readonly httpActiveRequests = new Gauge({
    name: 'http_active_requests',
    help: 'Number of currently in-flight HTTP requests',
    labelNames: ['method', 'route'],
    registers: [MetricsService.REGISTRY],
  });

  readonly httpErrorsTotal = new Counter({
    name: 'http_errors_total',
    help: 'Total number of HTTP requests that resulted in 4xx/5xx',
    labelNames: ['method', 'route', 'status_code'],
    registers: [MetricsService.REGISTRY],
  });

  onModuleInit(): void {
    collectDefaultMetrics({
      register: MetricsService.REGISTRY,
      prefix: 'voiceforge_api_',
    });
  }

  async getMetrics(): Promise<string> {
    return MetricsService.REGISTRY.metrics();
  }
}
