import { Module, OnApplicationShutdown } from '@nestjs/common';
// Import tracing to initialise the OpenTelemetry SDK as a side effect.
// It must be imported before any instrumented modules (Prisma, Express, etc.).
import './tracing';
import { logger } from './logging';
import { AgentsModule } from './agents/agents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CacheModule } from './cache/cache.module';
import { CallsModule } from './calls/calls.module';
import { ComplianceModule } from './compliance/compliance.module';
import { EmailModule } from './email/email.module';
import { EvaluationsModule } from './evaluations/evaluations.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LlmModule } from './llm/llm.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RateLimitModule } from './common/rate-limit.module';
import { TemplatesModule } from './templates/templates.module';
import { ToolsModule } from './tools/tools.module';
import { VoiceModule } from './voice/voice.module';
import { WhiteLabelModule } from './white-label/white-label.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { StripeWebhookModule } from './webhooks/stripe-webhook.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    EmailModule,
    QueueModule,
    CacheModule,
    RateLimitModule,
    AuthModule,
    HealthModule,
    WorkspacesModule,
    TemplatesModule,
    KnowledgeModule,
    LlmModule,
    AgentsModule,
    VoiceModule,
    EvaluationsModule,
    ComplianceModule,
    CallsModule,
    ToolsModule,
    AnalyticsModule,
    WhiteLabelModule,
    StripeWebhookModule,
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Application shutdown signal received');
  }
}
