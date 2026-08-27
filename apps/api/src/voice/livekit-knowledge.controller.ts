import { Body, Controller, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ForbiddenError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';

const LiveKitKnowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  max_chunks: z.number().int().min(1).max(20),
  retrieval_mode: z.enum(['agent_scoped', 'workspace_scoped']),
  // The admitted call the runtime is serving. Required: it is the only
  // caller-side identity that binds the path agentId to a tenant.
  call_id: z.string().uuid(),
});

type LiveKitKnowledgeSearch = z.infer<typeof LiveKitKnowledgeSearchSchema>;

/**
 * Service-to-service retrieval for the LiveKit runtime.
 *
 * `@InternalOnly()` proves the request came from our own runtime (the frontend
 * proxy forwards user context, which the guard refuses), but the shared key is
 * one credential for every tenant, so it cannot authorize the path `agentId`
 * by itself. The runtime therefore sends the id of the call it is serving,
 * and the request is refused unless that admitted call belongs to this agent.
 * Tenant scope is then derived from the verified call row, never from request
 * metadata.
 */
@InternalOnly()
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
    const call = await this.prisma.call.findUnique({
      where: { id: body.call_id },
      select: { agentId: true, workspaceId: true },
    });
    if (!call || call.agentId !== agentId) {
      throw new ForbiddenError('Call is not bound to this agent.');
    }

    const hits = await this.knowledge.search(call.workspaceId, body.query, {
      agentId: body.retrieval_mode === 'agent_scoped' ? agentId : undefined,
      k: body.max_chunks,
    });

    return { query: body.query, hits };
  }
}
