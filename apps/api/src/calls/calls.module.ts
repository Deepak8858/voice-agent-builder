import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { BillingModule } from '../billing/billing.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { WorkspaceGuard } from '../common/workspace.guard';
import { LiveKitModule } from '../livekit/livekit.module';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { VoiceWebhookController } from './voice-webhook.controller';

@Module({
  // LiveKit is needed for browser tests that run on the in-house pipeline;
  // VoiceModule is global, so the pipeline router resolves without an import.
  imports: [ComplianceModule, AnalyticsModule, BillingModule, LiveKitModule],
  controllers: [CallsController, VoiceWebhookController],
  providers: [CallsService, WorkspaceGuard],
  exports: [CallsService],
})
export class CallsModule {}
