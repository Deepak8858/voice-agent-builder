import { Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { CallsModule } from './calls/calls.module';
import { ComplianceModule } from './compliance/compliance.module';
import { EvaluationsModule } from './evaluations/evaluations.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LlmModule } from './llm/llm.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { TemplatesModule } from './templates/templates.module';
import { ToolsModule } from './tools/tools.module';
import { VoiceModule } from './voice/voice.module';
import { WhiteLabelModule } from './white-label/white-label.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    QueueModule,
    CacheModule,
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
  ],
})
export class AppModule {}
