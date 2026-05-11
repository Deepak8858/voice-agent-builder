import { Controller, Get, Post, Patch, Param, Body, Req } from '@nestjs/common';
import { OutboundCampaignService } from './outbound-campaign.service';

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
    return this.campaigns.getStats(campaignId);
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { agent_id: string; name: string; contacts: Array<{ phone: string; full_name?: string; email?: string; custom_data?: Record<string, string> }>; schedule?: Record<string, unknown> },
  ) {
    return this.campaigns.create(workspaceId, body);
  }

  @Post(':campaignId/start')
  async start(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    await this.campaigns.start(campaignId);
    return { success: true };
  }

  @Patch(':campaignId/pause')
  async pause(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    await this.campaigns.pause(campaignId);
    return { success: true };
  }
}