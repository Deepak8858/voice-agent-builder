import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { AgentSpecSchema, ToolTypeSchema } from '@voiceforge/shared';
import { Public } from '../common/decorators/public.decorator';
import { SkipResponseEnvelope } from '../common/decorators/skip-response-envelope.decorator';
import { SkipRateLimit } from '../common/rate-limit.guard';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ToolsService } from './tools.service';

const VapiToolCallSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const VapiToolCallsEnvelopeSchema = z.object({
  message: z.object({
    type: z.literal('tool-calls'),
    toolCallList: z.array(VapiToolCallSchema).min(1).max(20),
    call: z.object({ id: z.string().min(1).max(256) }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

type VapiToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
type VapiToolResult = {
  toolCallId: string;
  result?: string;
  error?: string;
};

/**
 * Provider-facing endpoint for synchronous Vapi function tools. Tenant scope,
 * tool names and expected tool types are derived from persisted records; no
 * workspace id or permission claim from the webhook body is trusted.
 */
@Public()
@Controller('voice/webhooks/vapi/agents/:agentId/tools')
export class VapiToolsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: ToolsService,
  ) {}

  @Post()
  @HttpCode(200)
  @SkipRateLimit()
  @SkipResponseEnvelope()
  async invoke(
    @Param('agentId') agentId: string,
    @Headers('x-vapi-secret') suppliedSecret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ results: VapiToolResult[] }> {
    assertVapiSecret(suppliedSecret);
    const payload = VapiToolCallsEnvelopeSchema.safeParse(body);
    if (!payload.success) {
      return { results: bestEffortErrorResults(body, 'Invalid Vapi tool-call payload.') };
    }
    const calls = payload.data.message.toolCallList.map((toolCall): VapiToolCall => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments ?? toolCall.parameters ?? {},
    }));

    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { workspaceId: true, activeVersionId: true, status: true },
    });
    if (!agent?.activeVersionId || agent.status !== 'published') {
      return { results: errorResults(calls, 'Published agent not found.') };
    }

    const version = await this.prisma.agentVersion.findUnique({
      where: { id: agent.activeVersionId },
      select: { specJson: true },
    });
    const parsedSpec = AgentSpecSchema.safeParse(version?.specJson);
    if (!parsedSpec.success) {
      return { results: errorResults(calls, 'Published agent configuration is invalid.') };
    }

    const declaredTools = new Map(parsedSpec.data.tools.map((tool) => [tool.name, tool]));
    const providerCallId = payload.data.message.call?.id ?? null;
    const call = providerCallId
      ? await this.prisma.call.findFirst({
          where: { provider: 'vapi', providerCallId, agentId },
          select: { id: true },
        })
      : null;

    const results = await Promise.all(
      calls.map(async (toolCall): Promise<VapiToolResult> => {
        const declared = declaredTools.get(toolCall.name);
        const expectedType = ToolTypeSchema.safeParse(declared?.permissions?.[0]);
        if (!declared || declared.permissions?.length !== 1 || !expectedType.success) {
          return {
            toolCallId: toolCall.id,
            error: oneLine(`Tool ${toolCall.name} is not authorized for this agent.`),
          };
        }

        try {
          const invocation = await this.tools.invokeByName(
            agent.workspaceId,
            toolCall.name,
            null,
            {
              arguments: toolCall.arguments,
              agent_id: agentId,
              ...(call ? { call_id: call.id } : {}),
            },
            expectedType.data,
          );
          if (invocation.status !== 'success') {
            return {
              toolCallId: toolCall.id,
              error: oneLine(invocation.error_message ?? 'Tool execution failed.'),
            };
          }
          return {
            toolCallId: toolCall.id,
            result: oneLine(JSON.stringify(invocation.response_body ?? { ok: true })),
          };
        } catch (err) {
          return {
            toolCallId: toolCall.id,
            error: oneLine(publicToolError(err)),
          };
        }
      }),
    );

    return { results };
  }
}

function assertVapiSecret(supplied: string | undefined): void {
  const expected = env.VAPI_WEBHOOK_SECRET ?? env.VOICE_WEBHOOK_SECRET;
  if (!expected || !supplied) throw new UnauthorizedException('Missing Vapi webhook secret');
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    throw new UnauthorizedException('Invalid Vapi webhook secret');
  }
}

function errorResults(calls: VapiToolCall[], error: string): VapiToolResult[] {
  return calls.map((call) => ({ toolCallId: call.id, error: oneLine(error) }));
}

function bestEffortErrorResults(body: unknown, error: string): VapiToolResult[] {
  const message = asRecord(asRecord(body).message);
  const rawCalls = Array.isArray(message.toolCallList) ? message.toolCallList : [];
  return rawCalls.flatMap((value): VapiToolResult[] => {
    const id = asRecord(value).id;
    return typeof id === 'string' && id
      ? [{ toolCallId: id, error: oneLine(error) }]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

function publicToolError(err: unknown): string {
  const status =
    err !== null && typeof err === 'object' && 'getStatus' in err
      ? Number((err as { getStatus: () => unknown }).getStatus())
      : 500;
  if (status >= 400 && status < 500 && err instanceof Error) return err.message;
  return 'Tool execution failed. Please try again.';
}
