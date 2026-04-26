import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateToolDtoSchema,
  InvokeToolDtoSchema,
  UpdateToolDtoSchema,
  type CreateToolDto,
  type InvokeToolDto,
  type SessionUser,
  type UpdateToolDto,
} from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ToolsService } from './tools.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId')
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Get('tools')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('agent_id') agentId?: string,
  ) {
    return { items: await this.tools.list(workspaceId, agentId ?? undefined) };
  }

  @Post('tools')
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateToolDtoSchema)) dto: CreateToolDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.tools.create(workspaceId, user.id, dto);
  }

  @Get('tools/:toolId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('toolId') toolId: string,
  ) {
    return this.tools.get(workspaceId, toolId);
  }

  @Patch('tools/:toolId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('toolId') toolId: string,
    @Body(new ZodValidationPipe(UpdateToolDtoSchema)) dto: UpdateToolDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.tools.update(workspaceId, toolId, user.id, dto);
  }

  @Delete('tools/:toolId')
  @HttpCode(204)
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('toolId') toolId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.tools.remove(workspaceId, toolId, user.id);
  }

  @Post('tools/:toolId/invoke')
  async invoke(
    @Param('workspaceId') workspaceId: string,
    @Param('toolId') toolId: string,
    @Body(new ZodValidationPipe(InvokeToolDtoSchema)) dto: InvokeToolDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.tools.invoke(workspaceId, toolId, user.id, dto);
  }

  @Get('tool-invocations')
  async listInvocations(
    @Param('workspaceId') workspaceId: string,
    @Query('tool_id') toolId?: string,
    @Query('agent_id') agentId?: string,
    @Query('call_id') callId?: string,
  ) {
    return {
      items: await this.tools.listInvocations(workspaceId, { toolId, agentId, callId }),
    };
  }
}
