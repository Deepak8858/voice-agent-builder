import { Body, Controller, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ToolTypeSchema } from '@voiceforge/shared';
import { AgentNotFoundError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { ToolsService } from './tools.service';

const LiveKitToolInvokeSchema = z.object({
  tool_name: z.string().min(1).max(64),
  params: z.record(z.string(), z.any()).default({}),
  call_id: z.string().uuid().optional(),
  // The tool type the Agent Spec declared for this tool. When present, the
  // lookup enforces it so a spec-declared Gmail tool can never resolve to a
  // same-named tool of another type.
  tool_type: ToolTypeSchema.optional(),
});

type LiveKitToolInvoke = z.infer<typeof LiveKitToolInvokeSchema>;

/**
 * Service-to-service tool invocation for the LiveKit runtime. The global
 * InternalAuthGuard protects this route with x-internal-key. Tenant scope is
 * deliberately derived from the persisted agent rather than accepted from
 * request metadata, matching LiveKitKnowledgeController.
 *
 * Dispatching goes through ToolsService.invoke, so every live-call tool run
 * gets the same ToolInvocation row and audit log entry as a dashboard run.
 */
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
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { workspaceId: true },
    });
    if (!agent) throw new AgentNotFoundError(agentId);

    const invocation = await this.tools.invokeByName(
      agent.workspaceId,
      body.tool_name,
      null,
      {
        arguments: body.params,
        ...(body.call_id ? { call_id: body.call_id } : {}),
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
