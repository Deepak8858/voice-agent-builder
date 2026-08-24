import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Param,
} from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { SessionScoped } from '../common/decorators/session-scoped.decorator';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { ReferralService } from './referral.service';
import { z } from 'zod';

const AcceptReferralSchema = z.object({
  inviteToken: z.string().min(1),
});

/**
 * `WorkspaceGuard` is applied at controller level but only three of these four
 * routes carry a `:workspaceId` param, so on the other three it did nothing.
 * Those are marked @SessionScoped(): they take the tenant from the verified
 * session, and `GET :workspaceId` remains genuinely guarded.
 *
 * Each session-scoped handler also derived its tenant as
 * `active_workspace_id ?? req.user.id`, falling back to the caller's *user* id
 * as a workspace id. A user id is never a valid workspace id, so the fallback
 * could only ever mis-scope: `createReferral` and `acceptReferral` would have
 * thrown a misleading "workspace not found" 401 from the service, and
 * `listReferrals` would have silently returned an empty list. Failing closed
 * here reports the real problem.
 */
@Controller('referrals')
@UseGuards(InternalAuthGuard, WorkspaceGuard)
export class ReferralController {
  constructor(private readonly referral: ReferralService) {}

  @Post()
  @SessionScoped()
  async createReferral(@CurrentUser() user: SessionUser | undefined) {
    const { userId, workspaceId } = this.requireWorkspace(user);
    const result = await this.referral.createReferral({
      actorUserId: userId,
      referrerWorkspaceId: workspaceId,
    });
    return {
      success: true,
      inviteToken: result.inviteToken,
      shareUrl: `/invite/${result.inviteToken}`,
    };
  }

  @Post('accept')
  @SessionScoped()
  async acceptReferral(
    @CurrentUser() user: SessionUser | undefined,
    @Body(new ZodValidationPipe(AcceptReferralSchema)) body: z.infer<typeof AcceptReferralSchema>,
  ) {
    const { userId, workspaceId } = this.requireWorkspace(user);
    const result = await this.referral.acceptReferral({
      inviteToken: body.inviteToken,
      referredUserId: userId,
      referredWorkspaceId: workspaceId,
    });
    return { success: true, ...result };
  }

  @Get()
  @SessionScoped()
  async listReferrals(@CurrentUser() user: SessionUser | undefined) {
    const { workspaceId } = this.requireWorkspace(user);
    return this.referral.listReferrals(workspaceId);
  }

  // Guarded by the controller-level WorkspaceGuard, which does apply here.
  @Get(':workspaceId')
  async getReferralsForWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.referral.listReferrals(workspaceId);
  }

  private requireWorkspace(user: SessionUser | undefined): {
    userId: string;
    workspaceId: string;
  } {
    if (!user?.id) throw new UnauthorizedError();
    const workspaceId = user.active_workspace_id;
    if (!workspaceId) throw new ForbiddenError('No active workspace for this session.');
    return { userId: user.id, workspaceId };
  }
}
