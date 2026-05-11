import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { CrmRoutingService } from './crm-routing.service';

@Controller('workspaces/:workspaceId/crm-routing')
export class CrmRoutingController {
  constructor(private readonly routing: CrmRoutingService) {}

  @Get('rules')
  async listRules(
    @Param('workspaceId') workspaceId: string,
    @Query('agent_id') agentId?: string,
  ) {
    const rules = await this.routing.getRulesForAgent(workspaceId, agentId ?? '');
    return { items: rules };
  }

  @Post('rules')
  async createRule(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { keyword: string; provider: string; action: 'primary' | 'secondary'; agent_id?: string },
  ) {
    const rule = await this.routing.createRule(workspaceId, body);
    return rule;
  }
}