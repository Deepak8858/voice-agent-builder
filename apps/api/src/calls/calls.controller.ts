import {
  Body,
  Controller,
  Get,
  Header,
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

  /**
   * Real-time SSE stream of call events.
   * Sends backfill of existing events first, then keeps connection open
   * publishing live events until the call ends or client disconnects.
   */
  @Get('calls/:callId/live')
  async live(
    @Param('workspaceId') workspaceId: string,
    @Param('callId') callId: string,
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

    const cache = res.app.get('cache') as import('../cache/cache.service').CacheService;
    const stream = cache.subscribe(`call:${callId}`);
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
