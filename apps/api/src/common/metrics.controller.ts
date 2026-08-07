import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../config/env';
import { Public } from './decorators/public.decorator';
import { MetricsService } from './metrics.service';
import { constantTimeEqual } from './secure-compare';

/**
 * Exposes Prometheus-formatted metrics at GET /api/v1/metrics.
 * Protected by a bearer token so metrics are not public on 0.0.0.0.
 */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async getMetrics(@Req() req: Request): Promise<string> {
    const auth = req.headers['authorization'];
    const expected = `Bearer ${env.METRICS_SCRAPE_TOKEN ?? ''}`;
    if (
      !env.METRICS_SCRAPE_TOKEN
      || typeof auth !== 'string'
      || !constantTimeEqual(auth, expected)
    ) {
      throw new UnauthorizedException();
    }
    return this.metrics.getMetrics();
  }
}