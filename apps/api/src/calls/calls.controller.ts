import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  StartOutboundCallDtoSchema,
  StartTestSessionDtoSchema,
  type SessionUser,
  type StartOutboundCallDto,
  type StartTestSessionDto,
} from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { RoleGuard } from '../common/role.guard';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { AgentNotFoundError, CallNotFoundError } from '../common/errors';
import { CacheService } from '../cache/cache.service';
import { CallsService } from './calls.service';

const callIdPipe = new UuidParamPipe((id) => new CallNotFoundError(id));
const agentIdPipe = new UuidParamPipe((id) => new AgentNotFoundError(id));

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly cache: CacheService,
  ) {}

  // Part of the agent-building loop, so editors are admitted like the rest of
  // agent authoring.
  @Post('agents/:agentId/test-session')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  async startTestSession(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId', agentIdPipe) agentId: string,
    @Body(new ZodValidationPipe(StartTestSessionDtoSchema)) dto: StartTestSessionDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.calls.startTestSession(workspaceId, agentId, user.id, dto);
  }

  // Dials a real, metered call — same bar as campaign start, and `fresh` for
  // the same reason: money must not move on a 300s-stale role.
  @Post('agents/:agentId/calls/outbound')
  @UseGuards(RoleGuard)
  @RequiredRole(['owner', 'admin'], { fresh: true })
  async startOutbound(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId', agentIdPipe) agentId: string,
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
    @Param('callId', callIdPipe) callId: string,
  ) {
    return this.calls.get(workspaceId, callId);
  }

  // Editors are admitted: anyone who can start a test session needs to be able
  // to kill it, and ending a call only ever stops spend.
  @Post('calls/:callId/end')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  async end(
    @Param('workspaceId') workspaceId: string,
    @Param('callId', callIdPipe) callId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.calls.end(workspaceId, callId, user.id);
  }

  /**
   * Real-time SSE stream of call events.
   * Sends backfill of existing events first, then keeps connection open
   * publishing live events until the call ends or client disconnects.
   */
  @Get('calls/:callId/live')
  async live(
    @Param('workspaceId') workspaceId: string,
    @Param('callId', callIdPipe) callId: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send backfill of existing events
    const backfill = await this.calls.getLiveEvents(callId, workspaceId);
    for (const event of backfill) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Keep connection open and stream live events
    let closed = false;
    res.on('close', () => { closed = true; });

    const stream = this.cache.subscribe(`call:${callId}`);
    const reader = stream.getReader();

    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(`data: ${value}\n\n`);
      }
    } finally {
      reader.cancel();
    }

    res.end();
  }
}
