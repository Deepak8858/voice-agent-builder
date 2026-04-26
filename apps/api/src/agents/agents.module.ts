import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../llm/llm.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [KnowledgeModule, LlmModule],
  controllers: [AgentsController],
  providers: [AgentsService, WorkspaceGuard],
  exports: [AgentsService],
})
export class AgentsModule {}
