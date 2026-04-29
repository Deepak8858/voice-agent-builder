import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../llm/llm.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [KnowledgeModule, LlmModule, BillingModule],
  controllers: [AgentsController],
  providers: [AgentsService, WorkspaceGuard],
  exports: [AgentsService],
})
export class AgentsModule {}
