import { Controller, Post, Delete, Get, Body, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CalendarService } from './calendar.service';

type AuthRequest = Request & { user: { id: string; active_workspace_id?: string } };

@Controller('workspaces/:workspaceId/calendar')
@UseGuards(InternalAuthGuard, WorkspaceGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('status')
  async getStatus(@Req() req: AuthRequest) {
    const connected = await this.calendar.isConnected(req.user.active_workspace_id ?? req.user.id);
    return { connected };
  }

  @Post('connect')
  async connect(
    @Req() req: AuthRequest,
    @Body() body: { access_token: string; refresh_token: string; token_expiry: string },
  ) {
    const workspaceId = req.user.active_workspace_id ?? req.user.id;
    await this.calendar.connectGoogleCalendar({
      workspaceId,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      tokenExpiry: body.token_expiry,
    });
    return { success: true };
  }

  @Delete('disconnect')
  async disconnect(@Req() req: AuthRequest) {
    const workspaceId = req.user.active_workspace_id ?? req.user.id;
    await this.calendar.disconnectGoogleCalendar(workspaceId);
    return { success: true };
  }
}
