import { Module } from '@nestjs/common';
import { EvaluationWorker } from './evaluation.worker';
import { AnalyticsWorker } from './analytics.worker';
import { AuditWorker } from './audit.worker';

@Module({
  providers: [EvaluationWorker, AnalyticsWorker, AuditWorker],
  exports: [EvaluationWorker, AnalyticsWorker, AuditWorker],
})
export class WorkersModule {}
