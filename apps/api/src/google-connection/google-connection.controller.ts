import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { SessionUser } from '@voiceforge/shared';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
import { UnauthorizedError } from '../common/errors';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GoogleConnectionService } from './google-connection.service';

const CallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
type CallbackDto = z.infer<typeof CallbackSchema>;

/** The audit trail needs a real actor; RoleGuard has already proven one exists. */
function actorId(user: SessionUser | undefined): string {
  if (!user?.id) throw new UnauthorizedError();
  return user.id;
}

/**
 * Connecting or disconnecting Google grants/revokes workspace-wide tools, so
 * viewers may read status but never mutate the connection. The editor tier is
 * deliberate: it mirrors the write RLS policy on google_oauth_connections
 * (owner/admin/editor). The two GET routes are gated too — `authorize` mints
 * the consent URL and `callback` completes the token exchange, both of which
 * lead straight to the mutation.
 */
@Controller('workspaces/:workspaceId/google')
@UseGuards(InternalAuthGuard, WorkspaceGuard)
export class GoogleConnectionController {
  constructor(private readonly google: GoogleConnectionService) {}

  /** Returns the Google consent URL and the signed CSRF `state`. */
  @Get('authorize')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  authorize(@Param('workspaceId') workspaceId: string) {
    return this.google.getAuthorizeUrl(workspaceId);
  }

  /** Browser redirect target forwarded through the web app (GET form). */
  @Get('callback')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  async callbackGet(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser | undefined,
    @Query(new ZodValidationPipe(CallbackSchema)) query: CallbackDto,
  ) {
    return this.google.completeOAuthCallback({
      workspaceId,
      code: query.code,
      state: query.state,
      actorUserId: actorId(user),
    });
  }

  /** Same exchange as GET, for callers that forward the callback as JSON. */
  @Post('callback')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  async callbackPost(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser | undefined,
    @Body(new ZodValidationPipe(CallbackSchema)) body: CallbackDto,
  ) {
    return this.google.completeOAuthCallback({
      workspaceId,
      code: body.code,
      state: body.state,
      actorUserId: actorId(user),
    });
  }

  @Get('status')
  async status(@Param('workspaceId') workspaceId: string) {
    return this.google.getStatus(workspaceId);
  }

  @Delete('disconnect')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  async disconnect(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser | undefined,
  ) {
    await this.google.disconnect(workspaceId, actorId(user));
    return { success: true };
  }
}
