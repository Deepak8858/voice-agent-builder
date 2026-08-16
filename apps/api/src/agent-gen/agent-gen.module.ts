import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { GenerationRateLimitGuard } from '../common/generation-rate-limit.guard';
import { AgentsModule } from '../agents/agents.module';
import { LlmModule } from '../llm/llm.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { AgentGenController } from './agent-gen.controller';
import { AgentGenService } from './agent-gen.service';

@Module({
  imports: [AgentsModule, KnowledgeModule, LlmModule, PrismaModule, QueueModule],
  controllers: [AgentGenController],
  providers: [AgentGenService, WorkspaceGuard, GenerationRateLimitGuard],
  exports: [AgentGenService],
})
export class AgentGenModule {}
