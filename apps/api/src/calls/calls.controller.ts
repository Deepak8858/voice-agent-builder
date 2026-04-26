import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  StartOutboundCallDtoSchema,
  StartTestSessionDtoSchema,
  type SessionUser,
  type StartOutboundCallDto,
  type StartTestSessionDto,
} from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CallsService } from './calls.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Post('agents/:agentId/test-session')
  async startTestSession(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(StartTestSessionDtoSchema)) dto: StartTestSessionDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.calls.startTestSession(workspaceId, agentId, user.id, dto);
  }

  @Post('agents/:agentId/calls/outbound')
  async startOutbound(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(StartOutboundCallDtoSchema)) dto: StartOutboundCallDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.calls.startOutboundCall(workspaceId, agentId, user.id, dto);
  }

  @Get('calls')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('agent_id') agentId?: string,
  ) {
    return { items: await this.calls.list(workspaceId, agentId) };
  }

  @Get('calls/:callId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('callId') callId: string,
  ) {
    return this.calls.get(workspaceId, callId);
  }

  @Post('calls/:callId/end')
  async end(
    @Param('workspaceId') workspaceId: string,
    @Param('callId') callId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.calls.end(workspaceId, callId, user.id);
  }
}
