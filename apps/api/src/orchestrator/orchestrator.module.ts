import { Module } from '@nestjs/common';
import { AgentOrchestratorService } from './orchestrator.service';
import { AgentOrchestratorController } from './orchestrator.controller';
import { AgentsModule } from '../agents/agents.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AgentsModule, KnowledgeModule, PrismaModule, QueueModule, AuditModule],
  controllers: [AgentOrchestratorController],
  providers: [AgentOrchestratorService],
  exports: [AgentOrchestratorService],
})
export class AgentOrchestratorModule {}
