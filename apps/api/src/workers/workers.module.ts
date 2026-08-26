import { Module } from '@nestjs/common';
import { AgentGenWorker } from './agent-gen.worker';
import { BillingReconciliationWorker } from './billing-reconciliation.worker';
import { CallLeaseRenewalWorker } from './call-lease-renewal.worker';
import { EvaluationWorker } from './evaluation.worker';
import { FreeCreditGrantWorker } from './free-credit-grant.worker';
import { AnalyticsWorker } from './analytics.worker';
import { AuditWorker } from './audit.worker';
import { EmbeddingsWorker } from './embeddings.worker';
import { DigestWorker } from './digest.worker';
import { OutboundCallWorker } from '../outbound-campaign/workers/outbound-call.worker';
import { OrchestratorWorker } from './orchestrator.worker';
import { AgentGenModule } from '../agent-gen/agent-gen.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';
import { LlmModule } from '../llm/llm.module';
import { QueueModule } from '../queue/queue.module';
import { TwilioModule } from '../twilio-adapter/twilio.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboundCampaignModule } from '../outbound-campaign/outbound-campaign.module';
import { CrmRoutingModule } from '../crm-routing/crm-routing.module';
import { CallsModule } from '../calls/calls.module';
import { TelephonyModule } from '../telephony/telephony.module';

@Module({
  imports: [
    AgentGenModule,
    AnalyticsModule,
    LlmModule,
    QueueModule,
    CallsModule,
    TwilioModule,
    PrismaModule,
    OutboundCampaignModule,
    CrmRoutingModule,
    TelephonyModule,
    EmailModule,
    BillingModule,
  ],
  providers: [
    AgentGenWorker,
    EvaluationWorker,
    AnalyticsWorker,
    AuditWorker,
    EmbeddingsWorker,
    DigestWorker,
    OutboundCallWorker,
    OrchestratorWorker,
    BillingReconciliationWorker,
    CallLeaseRenewalWorker,
    FreeCreditGrantWorker,
  ],
  exports: [
    AgentGenWorker,
    EvaluationWorker,
    AnalyticsWorker,
    AuditWorker,
    EmbeddingsWorker,
    DigestWorker,
    OutboundCallWorker,
    OrchestratorWorker,
    BillingReconciliationWorker,
    CallLeaseRenewalWorker,
    FreeCreditGrantWorker,
  ],
})
export class WorkersModule {}
