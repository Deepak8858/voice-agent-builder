import { Body, Controller, Get, Header, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CreateAgentDtoSchema,
  CreateAgentVersionDtoSchema,
  GenerateAgentDtoSchema,
  UpdateAgentDtoSchema,
  type CreateAgentDto,
  type CreateAgentVersionDto,
  type GenerateAgentDto,
  type UpdateAgentDto,
  type SessionUser,
} from '@voiceforge/shared';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser } from '../common/current-user.decorator';
import { AgentsService } from './agents.service';
import { PrismaService } from '../prisma/prisma.service';

const FlowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['start', 'speak', 'ask-question', 'condition', 'tool-call', 'transfer', 'end']),
  data: z.record(z.unknown()),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

const FlowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  type: z.string().optional(),
});

const UpdateFlowDtoSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(FlowEdgeSchema),
});

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.agents.list(workspaceId);
    res.setHeader('X-Cache-Hit', result.fromCache ? 'true' : 'false');
    return { items: result.agents };
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateAgentDtoSchema)) dto: CreateAgentDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.agents.create(workspaceId, user.id, dto);
  }

  @Post('generate')
  async generate(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(GenerateAgentDtoSchema)) dto: GenerateAgentDto,
  ) {
    return this.agents.generate(workspaceId, dto);
  }

  @Get('generate/stream')
  async generateStream(
    @Param('workspaceId') workspaceId: string,
    @Query('prompt') prompt: string,
    @Query('template_slug') templateSlug?: string,
  ) {
    if (!prompt) {
      return { error: 'prompt query param required' };
    }
    const dto: GenerateAgentDto = { prompt, template_slug: templateSlug };
    const generator = this.agents.getStreamingGenerator();
    if (!generator) {
      return { error: 'Streaming not supported by current LLM provider' };
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const token of generator(dto)) {
            controller.enqueue(`data: ${JSON.stringify({ token })}\n\n`);
          }
          controller.enqueue(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (err) {
          controller.enqueue(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  @Get(':agentId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.agents.get(workspaceId, agentId);
  }

  @Patch(':agentId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(UpdateAgentDtoSchema)) dto: UpdateAgentDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.agents.update(workspaceId, agentId, user.id, dto);
  }

  @Post(':agentId/versions')
  async createVersion(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(CreateAgentVersionDtoSchema)) dto: CreateAgentVersionDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.agents.createVersion(workspaceId, agentId, user.id, dto);
  }

  @Post(':agentId/publish')
  async publish(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.agents.publish(workspaceId, agentId, user.id);
  }

  @Post(':agentId/pause')
  async pause(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.agents.pause(workspaceId, agentId, user.id);
  }

  @Patch(':agentId/flow')
  async updateFlow(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(UpdateFlowDtoSchema)) body: z.infer<typeof UpdateFlowDtoSchema>,
    @CurrentUser() user: SessionUser,
  ) {
    return this.agents.updateFlow(workspaceId, agentId, user.id, body);
  }
}

// Public agent share endpoints (no workspace guard)
@Controller('agents')
export class PublicAgentsController {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  @Get('a/:id')
  async getById(@Param('id') id: string) {
    // Find published agent by ID
    const agent = await this.prisma.agent.findFirst({
      where: {
        id: id,
        status: 'published',
      },
    });

    if (!agent) {
      return { found: false };
    }

    // Get latest version
    const version = await this.prisma.agentVersion.findFirst({
      where: { agentId: agent.id },
      orderBy: { versionNumber: 'desc' },
    });

    const spec = version?.specJson as Record<string, unknown> ?? {};

    return {
      found: true,
      id: agent.id,
      name: agent.name,
      demoAudioUrl: null,
      sampleTranscript: this.buildSampleTranscript(spec),
      spec: {
        identity: spec['identity'] as Record<string, unknown> ?? {},
        voice: spec['voice'] as Record<string, unknown> ?? {},
        goals: (spec['goals'] as string[]) ?? [],
      },
      workspaceName: 'VoiceForge Agent',
      organizationName: null,
      publishedAt: version?.createdAt ?? agent.createdAt,
    };
  }

  private buildSampleTranscript(spec: Record<string, unknown>): Array<{ speaker: string; text: string }> {
    const goals = (spec['goals'] as string[]) ?? [];
    const identity = (spec['identity'] as Record<string, unknown>) ?? {};
    const businessName = (identity['business_name'] as string) ?? 'our business';

    return [
      { speaker: 'agent', text: `Hello, this is the AI assistant at ${businessName}. How can I help you today?` },
      { speaker: 'caller', text: "Hi, I'd like to schedule an appointment." },
      { speaker: 'agent', text: "Of course! I'd be happy to help you with that. What day works best for you?" },
      { speaker: 'caller', text: 'Would next Tuesday work?' },
      { speaker: 'agent', text: "Yes, we have availability on Tuesday at 2pm. Would that work for you?" },
      { speaker: 'caller', text: "Perfect, let's book it." },
      { speaker: 'agent', text: `Great, you're all set for Tuesday at 2pm. We'll see you then!` },
    ];
  }
}
