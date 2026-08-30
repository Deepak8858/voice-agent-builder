import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateOutboundCampaignDtoSchema,
  type CreateOutboundCampaignDto,
  type SessionUser,
} from '@voiceforge/shared';
import { WorkspaceGuard } from '../common/workspace.guard';
import { RoleGuard } from '../common/role.guard';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OutboundCampaignService } from './outbound-campaign.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/campaigns')
export class OutboundCampaignController {
  constructor(private readonly campaigns: OutboundCampaignService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    const campaigns = await this.campaigns.list(workspaceId);
    return { items: campaigns };
  }

  @Get(':campaignId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.campaigns.getCampaign(workspaceId, campaignId);
  }

  @Get(':campaignId/stats')
  async getStats(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.campaigns.getStats(workspaceId, campaignId);
  }

  // A campaign exists only to spend money on bulk calls, and the dashboard
  // starts one in the same click that creates it — so the whole lifecycle is
  // owner/admin, not just `start`. An editor-creatable draft would strand a
  // campaign the editor can never run.
  @Post()
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateOutboundCampaignDtoSchema)) body: CreateOutboundCampaignDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.campaigns.create(workspaceId, user.id, body);
  }

  // `fresh` because start dials paid calls: a just-demoted admin must not be
  // able to launch one from the 300s role cache.
  @Post(':campaignId/start')
  @UseGuards(RoleGuard)
  @RequiredRole(['owner', 'admin'], { fresh: true })
  async start(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.campaigns.start(workspaceId, campaignId, user.id);
    return { success: true };
  }

  @Patch(':campaignId/pause')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  async pause(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.campaigns.pause(workspaceId, campaignId, user.id);
    return { success: true };
  }
}
