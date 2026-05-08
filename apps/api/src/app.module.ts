import { Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
// Import and start OpenTelemetry before any instrumented modules (Prisma, Express, etc.).
import { otel } from './tracing';
otel.start();
import { logger } from './logging';
import { RateLimitGuard } from './common/rate-limit.guard';
import { MetricsModule } from './common/metrics.module';
import { AgentsModule } from './agents/agents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CacheModule } from './cache/cache.module';
import { CallsModule } from './calls/calls.module';
import { ComplianceModule } from './compliance/compliance.module';
import { EvaluationsModule } from './evaluations/evaluations.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LlmModule } from './llm/llm.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { WorkersModule } from './workers/workers.module';
import { RateLimitModule } from './common/rate-limit.module';
import { TemplatesModule } from './templates/templates.module';
import { ToolsModule } from './tools/tools.module';
import { VoiceModule } from './voice/voice.module';
import { WhiteLabelModule } from './white-label/white-label.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { StripeWebhookModule } from './webhooks/stripe-webhook.module';
import { EmailModule } from './email/email.module';

@Module({
  imports: [
    MetricsModule,
    PrismaModule,
    AuditModule,
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
    WorkersModule,
    WhiteLabelModule,
    StripeWebhookModule,
    BillingModule,
    EmailModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Application shutdown signal received');
  }
}
