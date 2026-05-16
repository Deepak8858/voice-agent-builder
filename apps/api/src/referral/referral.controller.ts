import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  Param,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ReferralService } from './referral.service';
import { z } from 'zod';

const AcceptReferralSchema = z.object({
  inviteToken: z.string().min(1),
});

type AuthenticatedRequest = Request & { user: { id: string; active_workspace_id?: string; active_workspace_name?: string; active_workspace_role?: string } };

@Controller('referrals')
@UseGuards(InternalAuthGuard, WorkspaceGuard)
export class ReferralController {
  constructor(private readonly referral: ReferralService) {}

  @Post()
  async createReferral(@Req() req: AuthenticatedRequest) {
    const workspaceId = req.user.active_workspace_id ?? req.user.id;
    const result = await this.referral.createReferral({
      actorUserId: req.user.id,
      referrerWorkspaceId: workspaceId,
    });
    return {
      success: true,
      inviteToken: result.inviteToken,
      shareUrl: `/invite/${result.inviteToken}`,
    };
  }

  @Post('accept')
  async acceptReferral(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(AcceptReferralSchema)) body: z.infer<typeof AcceptReferralSchema>,
  ) {
    const workspaceId = req.user.active_workspace_id ?? req.user.id;
    const result = await this.referral.acceptReferral({
      inviteToken: body.inviteToken,
      referredUserId: req.user.id,
      referredWorkspaceId: workspaceId,
    });
    return { success: true, ...result };
  }

  @Get()
  async listReferrals(@Req() req: AuthenticatedRequest) {
    return this.referral.listReferrals(req.user.active_workspace_id ?? req.user.id);
  }

  @Get(':workspaceId')
  async getReferralsForWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.referral.listReferrals(workspaceId);
  }
}
