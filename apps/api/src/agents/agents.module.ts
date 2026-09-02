import { Module } from '@nestjs/common';
import { AgentSheetsModule } from '../agent-sheets/agent-sheets.module';
import { WorkspaceGuard } from '../common/workspace.guard';
import { GenerationRateLimitGuard } from '../common/generation-rate-limit.guard';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../llm/llm.module';
import { AgentsController, PublicAgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  // AgentSheetsModule: publish creates/extends the agent's Google Sheet.
  imports: [KnowledgeModule, LlmModule, BillingModule, PrismaModule, AgentSheetsModule],
  controllers: [AgentsController, PublicAgentsController],
  providers: [AgentsService, WorkspaceGuard, GenerationRateLimitGuard],
  exports: [AgentsService],
})
export class AgentsModule {}
