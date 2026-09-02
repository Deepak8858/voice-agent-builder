import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { CrmRoutingService } from './crm-routing.service';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { AgentNotFoundError } from '../common/errors';
import { CreateCrmRoutingRuleDtoSchema, type CreateCrmRoutingRuleDto } from './crm-routing.schemas';
import { CurrentUser } from '../common/current-user.decorator';
import type { SessionUser } from '@voiceforge/shared';

const agentIdPipe = new UuidParamPipe((id) => new AgentNotFoundError(id));

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/crm-routing')
export class CrmRoutingController {
  constructor(private readonly routing: CrmRoutingService) {}

  @Get('rules')
  async listRules(
    @Param('workspaceId') workspaceId: string,
    // The `agent_id` filter is optional: absent means "every rule in the
    // workspace". The pipe rejects a present but malformed id with a 404 rather
    // than letting it reach the `uuid` column and throw P2023 as a 500.
    @Query('agent_id', agentIdPipe) agentId?: string,
  ) {
    const rules = await this.routing.getRulesForAgent(workspaceId, agentId);
    return { items: rules };
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('rules')
  async createRule(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateCrmRoutingRuleDtoSchema)) body: CreateCrmRoutingRuleDto,
    @CurrentUser() user: SessionUser,
  ) {
    // The actor is passed through so the audit row names a person. The service
    // parameter is optional because orchestrator.worker also calls createRule
    // and genuinely has no actor; a request always does.
    const rule = await this.routing.createRule(workspaceId, body, user.id);
    return rule;
  }
}
