import { Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
// Import and start OpenTelemetry before any instrumented modules (Prisma, Express, etc.).
import { otel } from './tracing';
otel.start();
import { logger } from './logging';
import { RateLimitGuard } from './common/rate-limit.guard';
import { MetricsModule } from './common/metrics.module';
import { AgentGenModule } from './agent-gen/agent-gen.module';
import { AgentsModule } from './agents/agents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { AuditExportModule } from './audit/audit-export.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CacheModule } from './cache/cache.module';
import { CallsModule } from './calls/calls.module';
import { ComplianceModule } from './compliance/compliance.module';
import { EvaluationsModule } from './evaluations/evaluations.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LlmModule } from './llm/llm.module';
import { PostHogModule } from './posthog/posthog.module';
import { PostHogService } from './posthog/posthog.service';
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
import { AgentOrchestratorModule } from './orchestrator/orchestrator.module';
import { OutboundCampaignModule } from './outbound-campaign/outbound-campaign.module';
import { PhoneNumbersModule } from './phone-numbers/phone-numbers.module';
import { WorkspaceCrmModule } from './workspace-crm/workspace-crm.module';
import { CrmRoutingModule } from './crm-routing/crm-routing.module';
import { TwilioModule } from './twilio-adapter/twilio.module';
import { SettingsModule } from './settings/settings.module';
import { ReferralModule } from './referral/referral.module';
import { CalendarModule } from './calendar/calendar.module';
import { LiveKitModule } from './livekit/livekit.module';
import { SecurityModule } from './security/security.module';
import { TelephonyModule } from './telephony/telephony.module';
import { env } from './config/env';

@Module({
  imports: [
    MetricsModule,
    PostHogModule,
    PrismaModule,
    AuditModule,
    QueueModule,
    CacheModule,
    RateLimitModule,
    AuthModule,
    SecurityModule,
    HealthModule,
    WorkspacesModule,
    TemplatesModule,
    KnowledgeModule,
    LlmModule,
    AgentsModule,
    AgentGenModule,
    VoiceModule,
    LiveKitModule,
    TelephonyModule,
    EvaluationsModule,
    ComplianceModule,
    CallsModule,
    ToolsModule,
    AnalyticsModule,
    ...(env.WORKERS_ENABLED ? [WorkersModule] : []),
    WhiteLabelModule,
    StripeWebhookModule,
    BillingModule,
    EmailModule,
    TwilioModule,
    AgentOrchestratorModule,
    OutboundCampaignModule,
    PhoneNumbersModule,
    WorkspaceCrmModule,
    CrmRoutingModule,
    AuditExportModule,
    SettingsModule,
    ReferralModule,
    CalendarModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(private readonly posthog: PostHogService) {}

  async onApplicationShutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Application shutdown signal received');
    // Flush queued analytics. No-op when disabled and never throws, so it
    // cannot delay or fail shutdown.
    await this.posthog.shutdown();
  }
}
