import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
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

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return { items: await this.agents.list(workspaceId) };
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
}
