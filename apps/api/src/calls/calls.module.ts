import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { VoiceWebhookController } from './voice-webhook.controller';

@Module({
  imports: [ComplianceModule, AnalyticsModule],
  controllers: [CallsController, VoiceWebhookController],
  providers: [CallsService, WorkspaceGuard],
  exports: [CallsService],
})
export class CallsModule {}
