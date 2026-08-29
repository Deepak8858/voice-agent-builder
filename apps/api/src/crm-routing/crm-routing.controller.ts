import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { CrmRoutingService } from './crm-routing.service';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CreateCrmRoutingRuleDtoSchema, type CreateCrmRoutingRuleDto } from './crm-routing.schemas';

@UseGuards(WorkspaceGuard)
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

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('rules')
  async createRule(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateCrmRoutingRuleDtoSchema)) body: CreateCrmRoutingRuleDto,
  ) {
    const rule = await this.routing.createRule(workspaceId, body);
    return rule;
  }
}
