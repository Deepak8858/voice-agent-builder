import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_MIDDLEWARE } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsMiddleware } from './metrics.middleware';

/**
 * Global metrics module — registers the /metrics endpoint and Prometheus middleware.
 * Must be imported early so middleware is registered before all other modules.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    // MetricsMiddleware is applied as a global middleware
    { provide: APP_MIDDLEWARE, useClass: MetricsMiddleware },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
