import { Body, Controller, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AgentNotFoundError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';

const LiveKitKnowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  max_chunks: z.number().int().min(1).max(20),
  retrieval_mode: z.enum(['agent_scoped', 'workspace_scoped']),
});

type LiveKitKnowledgeSearch = z.infer<typeof LiveKitKnowledgeSearchSchema>;

/**
 * Service-to-service retrieval for the LiveKit runtime. Global InternalAuthGuard
 * protects this route with x-internal-key. Tenant scope is deliberately derived
 * from the persisted agent rather than accepted from request metadata.
 */
@Controller('internal/livekit/agents/:agentId/knowledge')
export class LiveKitKnowledgeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  @Post('search')
  async search(
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(LiveKitKnowledgeSearchSchema)) body: LiveKitKnowledgeSearch,
  ) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { workspaceId: true },
    });
    if (!agent) throw new AgentNotFoundError(agentId);

    const hits = await this.knowledge.search(agent.workspaceId, body.query, {
      agentId: body.retrieval_mode === 'agent_scoped' ? agentId : undefined,
      k: body.max_chunks,
    });

    return { query: body.query, hits };
  }
}
