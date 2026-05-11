import { Module } from '@nestjs/common';
import { EvaluationWorker } from './evaluation.worker';
import { AnalyticsWorker } from './analytics.worker';
import { AuditWorker } from './audit.worker';
import { EmbeddingsWorker } from './embeddings.worker';
import { OutboundCallWorker } from '../outbound-campaign/workers/outbound-call.worker';
import { OrchestratorWorker } from './orchestrator.worker';
import { AnalyticsModule } from '../analytics/analytics.module';
import { LlmModule } from '../llm/llm.module';
import { QueueModule } from '../queue/queue.module';
import { TwilioModule } from '../twilio-adapter/twilio.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboundCampaignModule } from '../outbound-campaign/outbound-campaign.module';
import { CrmRoutingModule } from '../crm-routing/crm-routing.module';

@Module({
  imports: [
    AnalyticsModule,
    LlmModule,
    QueueModule,
    TwilioModule,
    PrismaModule,
    OutboundCampaignModule,
    CrmRoutingModule,
  ],
  providers: [
    EvaluationWorker,
    AnalyticsWorker,
    AuditWorker,
    EmbeddingsWorker,
    OutboundCallWorker,
    OrchestratorWorker,
  ],
  exports: [
    EvaluationWorker,
    AnalyticsWorker,
    AuditWorker,
    EmbeddingsWorker,
    OutboundCallWorker,
    OrchestratorWorker,
  ],
})
export class WorkersModule {}
