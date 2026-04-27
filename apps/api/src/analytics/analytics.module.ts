import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, WorkspaceGuard],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
