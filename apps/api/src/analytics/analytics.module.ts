import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { WorkspaceGuard } from '../common/workspace.guard';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  // For the plan gate on the reporting routes. BillingModule declares no
  // `imports:` of its own, so this cannot form a cycle.
  imports: [BillingModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, WorkspaceGuard],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
