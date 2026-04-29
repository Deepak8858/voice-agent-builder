import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Exposes Prometheus-formatted metrics at GET /api/v1/metrics.
 * No authentication — intended for scraping by Prometheus / Grafana agents
 * on the same private network (API port 4000 is bound to 127.0.0.1 only).
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async getMetrics(): Promise<string> {
    return this.metrics.getMetrics();
  }
}