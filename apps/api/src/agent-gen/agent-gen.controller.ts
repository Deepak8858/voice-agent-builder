import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  FinalizeGenSessionDtoSchema,
  SendGenMessageDtoSchema,
  type FinalizeGenSessionDto,
  type SendGenMessageDto,
  type SessionUser,
} from '@voiceforge/shared';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser } from '../common/current-user.decorator';
import { GenerationRateLimitGuard } from '../common/generation-rate-limit.guard';
import { AgentGenService } from './agent-gen.service';

/**
 * Chat-to-agent generation sessions. All routes are workspace-scoped and
 * additionally user-scoped inside the service: a session belongs to the user
 * who created it and is never visible to workspace teammates.
 */
@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/agent-gen-sessions')
export class AgentGenController {
  constructor(private readonly sessions: AgentGenService) {}

  /** Creates (or resumes) the user's active session. */
  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.sessions.createSession(workspaceId, user.id);
  }

  /** Returns the active session (for refresh-resume), or null. */
  @Get('active')
  async active(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
  ) {
    const session = await this.sessions.getActiveSession(workspaceId, user.id);
    return { session };
  }

  @Get(':sessionId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.sessions.getSession(workspaceId, user.id, sessionId);
  }

  /**
   * Appends a user message and enqueues generation. Returns 202 with the
   * session snapshot (status 'generating'); the client polls GET /:sessionId.
   * 409 if a generation is already running.
   */
  @Post(':sessionId/messages')
  @UseGuards(GenerationRateLimitGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async sendMessage(
    @Param('workspaceId') workspaceId: string,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(SendGenMessageDtoSchema)) dto: SendGenMessageDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.sessions.sendMessage(workspaceId, user.id, sessionId, dto);
  }

  /** Creates the real agent from the session's spec; optionally publishes. */
  @Post(':sessionId/finalize')
  async finalize(
    @Param('workspaceId') workspaceId: string,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(FinalizeGenSessionDtoSchema)) dto: FinalizeGenSessionDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.sessions.finalize(workspaceId, user.id, sessionId, dto);
  }

  /** Discards a session (e.g. "start over"). */
  @Delete(':sessionId')
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.sessions.deleteSession(workspaceId, user.id, sessionId);
    return { deleted: true };
  }
}
