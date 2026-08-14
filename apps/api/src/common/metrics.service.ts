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
 * Billing/runtime metrics (see docs/operations/billing-runbook.md):
 *   - voiceforge_billing_available_seconds        — sellable credit not yet reserved
 *   - voiceforge_billing_reserved_seconds         — credit held by in-flight calls
 *   - voiceforge_calls_active_global              — concurrent calls platform-wide
 *   - voiceforge_calls_admission_denied_total{reason}
 *   - voiceforge_provider_cost_usd_total{provider, category, estimate}
 *   - voiceforge_plan_contribution_margin_ratio{plan}
 *   - voiceforge_billing_reconciliation_corrections_total{type}
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

  /**
   * Sellable credit across all organizations. Paired with reserved seconds so
   * an operator can distinguish "we are out of credit" from "credit is held by
   * calls that never released their reservation".
   */
  readonly billingAvailableSeconds = new Gauge({
    name: 'voiceforge_billing_available_seconds',
    help: 'Total credit seconds available across organizations',
    registers: [MetricsService.REGISTRY],
  });

  readonly billingReservedSeconds = new Gauge({
    name: 'voiceforge_billing_reserved_seconds',
    help: 'Total credit seconds currently reserved by in-flight calls',
    registers: [MetricsService.REGISTRY],
  });

  readonly callsActiveGlobal = new Gauge({
    name: 'voiceforge_calls_active_global',
    help: 'Number of active concurrency leases across the platform',
    registers: [MetricsService.REGISTRY],
  });

  /** Labelled by entitlement reason so denials are attributable to a cause. */
  readonly callsAdmissionDeniedTotal = new Counter({
    name: 'voiceforge_calls_admission_denied_total',
    help: 'Calls refused admission, by reason',
    labelNames: ['reason'],
    registers: [MetricsService.REGISTRY],
  });

  /**
   * Persisted provider spend observed by this process. This is a gauge because
   * an estimate can be replaced by a smaller actual and must move between the
   * estimate labels without replay inflation.
   */
  readonly providerCostUsdTotal = new Gauge({
    name: 'voiceforge_provider_cost_usd_total',
    help: 'Provider cost in USD, by provider, service category, and estimate flag',
    labelNames: ['provider', 'category', 'estimate'],
    registers: [MetricsService.REGISTRY],
  });

  readonly planContributionMarginRatio = new Gauge({
    name: 'voiceforge_plan_contribution_margin_ratio',
    help: 'Revenue minus provider cost, divided by revenue, per plan',
    labelNames: ['plan'],
    registers: [MetricsService.REGISTRY],
  });

  readonly billingReconciliationCorrectionsTotal = new Counter({
    name: 'voiceforge_billing_reconciliation_corrections_total',
    help: 'Corrections applied by billing reconciliation, by type',
    labelNames: ['type'],
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
