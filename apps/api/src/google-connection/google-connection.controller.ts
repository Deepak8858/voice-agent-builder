import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { SessionUser } from '@voiceforge/shared';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ForbiddenError } from '../common/errors';
import { GoogleConnectionService } from './google-connection.service';

const CallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
type CallbackDto = z.infer<typeof CallbackSchema>;

@Controller('workspaces/:workspaceId/google')
@UseGuards(InternalAuthGuard, WorkspaceGuard)
export class GoogleConnectionController {
  constructor(private readonly google: GoogleConnectionService) {}

  /**
   * Connecting or disconnecting Google grants/revokes workspace-wide tools,
   * so viewers may read status but never mutate the connection. Mirrors the
   * write RLS policy on google_oauth_connections (owner/admin/editor).
   */
  private assertCanManageConnection(req: Request): SessionUser {
    const user = (req as Request & { user?: SessionUser }).user;
    const role = user?.active_workspace_role;
    if (role !== 'owner' && role !== 'admin' && role !== 'editor') {
      throw new ForbiddenError(
        'Only workspace owners, admins, and editors can manage the Google connection.',
      );
    }
    return user as SessionUser;
  }

  /** Returns the Google consent URL and the signed CSRF `state`. */
  @Get('authorize')
  authorize(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    this.assertCanManageConnection(req);
    return this.google.getAuthorizeUrl(workspaceId);
  }

  /** Browser redirect target forwarded through the web app (GET form). */
  @Get('callback')
  async callbackGet(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Query(new ZodValidationPipe(CallbackSchema)) query: CallbackDto,
  ) {
    const user = this.assertCanManageConnection(req);
    return this.google.completeOAuthCallback({
      workspaceId,
      code: query.code,
      state: query.state,
      actorUserId: user.id,
    });
  }

  /** Same exchange as GET, for callers that forward the callback as JSON. */
  @Post('callback')
  async callbackPost(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CallbackSchema)) body: CallbackDto,
  ) {
    const user = this.assertCanManageConnection(req);
    return this.google.completeOAuthCallback({
      workspaceId,
      code: body.code,
      state: body.state,
      actorUserId: user.id,
    });
  }

  @Get('status')
  async status(@Param('workspaceId') workspaceId: string) {
    return this.google.getStatus(workspaceId);
  }

  @Delete('disconnect')
  async disconnect(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    const user = this.assertCanManageConnection(req);
    await this.google.disconnect(workspaceId, user.id);
    return { success: true };
  }
}
