import { Body, Controller, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ToolTypeSchema } from '@voiceforge/shared';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ForbiddenError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { ToolsService } from './tools.service';

const LiveKitToolInvokeSchema = z.object({
  tool_name: z.string().min(1).max(64),
  params: z.record(z.string(), z.any()).default({}),
  // The admitted call the runtime is serving. Required: it is the only
  // caller-side identity that binds the path agentId to a tenant.
  call_id: z.string().uuid(),
  idempotency_key: z.string().min(1).max(200).optional(),
  // The tool type the Agent Spec declared for this tool. When present, the
  // lookup enforces it so a spec-declared Gmail tool can never resolve to a
  // same-named tool of another type.
  tool_type: ToolTypeSchema.optional(),
});

type LiveKitToolInvoke = z.infer<typeof LiveKitToolInvokeSchema>;

/**
 * Service-to-service tool invocation for the LiveKit runtime.
 *
 * Dispatching goes through ToolsService.invoke, so every live-call tool run
 * gets the same ToolInvocation row and audit log entry as a dashboard run.
 *
 * `@InternalOnly()` proves the request came from our own runtime, but the
 * shared key is one credential for every tenant, so it cannot authorize the
 * path `agentId` by itself — a holder of the key could otherwise execute any
 * workspace's connected Google tools by agent id. The runtime therefore sends
 * the id of the admitted call it is serving, and the request is refused
 * unless that call belongs to this agent. Tenant scope is then derived from
 * the verified call row, matching LiveKitKnowledgeController.
 */
@InternalOnly()
@Controller('internal/livekit/agents/:agentId/tools')
export class LiveKitToolsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: ToolsService,
  ) {}

  @Post('invoke')
  async invoke(
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(LiveKitToolInvokeSchema)) body: LiveKitToolInvoke,
  ) {
    const call = await this.prisma.call.findUnique({
      where: { id: body.call_id },
      select: { agentId: true, workspaceId: true },
    });
    if (!call || call.agentId !== agentId) {
      throw new ForbiddenError('Call is not bound to this agent.');
    }

    const invocation = await this.tools.invokeByName(
      call.workspaceId,
      body.tool_name,
      null,
      {
        arguments: body.params,
        call_id: body.call_id,
        ...(body.idempotency_key ? { idempotency_key: body.idempotency_key } : {}),
        agent_id: agentId,
      },
      body.tool_type,
    );

    return {
      status: invocation.status,
      result: invocation.response_body,
      error_message: invocation.error_message,
    };
  }
}
