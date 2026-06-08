import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateOutboundCampaignDtoSchema,
  type CreateOutboundCampaignDto,
  type SessionUser,
} from '@voiceforge/shared';
import { WorkspaceGuard } from '../common/workspace.guard';
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

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateOutboundCampaignDtoSchema)) body: CreateOutboundCampaignDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.campaigns.create(workspaceId, user.id, body);
  }

  @Post(':campaignId/start')
  async start(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.campaigns.start(workspaceId, campaignId, user.id);
    return { success: true };
  }

  @Patch(':campaignId/pause')
  async pause(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.campaigns.pause(workspaceId, campaignId, user.id);
    return { success: true };
  }
}
