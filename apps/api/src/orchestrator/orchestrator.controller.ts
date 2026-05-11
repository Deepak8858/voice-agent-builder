import { Controller, Post, Get, Param, Body, Req, UseGuards } from '@nestjs/common';
import { AgentOrchestratorService } from './orchestrator.service';
import { GenerateAgentDto } from './dto/generate-agent.dto';

@Controller('agents/generate')
export class AgentOrchestratorController {
  constructor(private readonly orchestrator: AgentOrchestratorService) {}

  @Post()
  async startGeneration(
    @Req() req: { user?: { id: string; workspaceId?: string }; workspace?: { id: string } },
    @Body() dto: GenerateAgentDto,
  ) {
    const userId = req.user?.id ?? 'system';
    const workspaceId = req.workspace?.id ?? req.user?.workspaceId ?? req.user?.id ?? '';
    return this.orchestrator.startGeneration(workspaceId, userId, dto);
  }

  @Get(':agentId')
  async getStatus(
    @Req() req: { workspace?: { id: string } },
    @Param('agentId') agentId: string,
  ) {
    const workspaceId = req.workspace?.id ?? '';
    return this.orchestrator.getStatus(workspaceId, agentId);
  }

  @Post(':agentId/publish')
  async publish(
    @Req() req: { user?: { id: string }; workspace?: { id: string } },
    @Param('agentId') agentId: string,
  ) {
    const userId = req.user?.id ?? 'system';
    const workspaceId = req.workspace?.id ?? req.user?.id ?? '';
    await this.orchestrator.publish(workspaceId, agentId, userId);
    return { success: true };
  }
}
