import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';
import { AgentOrchestratorService } from './orchestrator.service';
import { GenerateAgentDto } from './dto/generate-agent.dto';
import { CurrentUser } from '../common/current-user.decorator';
import { ForbiddenError, UnauthorizedError } from '../common/errors';

/**
 * These routes are not workspace-scoped in their path, so `WorkspaceGuard` has
 * no `:workspaceId` to check and the tenant must come from the session.
 *
 * The previous derivation was
 * `req.workspace?.id ?? req.user?.workspaceId ?? req.user?.id ?? ''`. Nothing in
 * this codebase ever assigns `req.workspace`, and `SessionUser` has no
 * `workspaceId` property, so in practice it resolved to the caller's *user id*
 * and, failing that, the empty string. Both are wrong in the dangerous
 * direction: a user id is a well-formed id that simply belongs to no workspace,
 * and `''` matched nothing while still looking like a successful request.
 *
 * `active_workspace_id` is set by the global `InternalAuthGuard` from a verified
 * Supabase token via a membership lookup, so it is authoritative and the caller
 * cannot influence it. It is nullable, and a session without an active
 * workspace must fail closed rather than fall back to a guess.
 */
@Controller('agents/generate')
export class AgentOrchestratorController {
  constructor(private readonly orchestrator: AgentOrchestratorService) {}

  @Post()
  async startGeneration(
    @CurrentUser() user: SessionUser | undefined,
    @Body() dto: GenerateAgentDto,
  ) {
    const { userId, workspaceId } = this.requireWorkspace(user);
    return this.orchestrator.startGeneration(workspaceId, userId, dto);
  }

  @Get(':agentId')
  async getStatus(
    @CurrentUser() user: SessionUser | undefined,
    @Param('agentId') agentId: string,
  ) {
    const { workspaceId } = this.requireWorkspace(user);
    return this.orchestrator.getStatus(workspaceId, agentId);
  }

  @Post(':agentId/publish')
  async publish(
    @CurrentUser() user: SessionUser | undefined,
    @Param('agentId') agentId: string,
  ) {
    const { userId, workspaceId } = this.requireWorkspace(user);
    await this.orchestrator.publish(workspaceId, agentId, userId);
    return { success: true };
  }

  /**
   * Resolves the acting user and their active workspace, or refuses the request.
   * There is deliberately no fallback: these endpoints create and publish
   * agents, so acting against an unverified or absent workspace is worse than
   * returning an error.
   */
  private requireWorkspace(user: SessionUser | undefined): {
    userId: string;
    workspaceId: string;
  } {
    if (!user?.id) throw new UnauthorizedError();
    const workspaceId = user.active_workspace_id;
    if (!workspaceId) {
      throw new ForbiddenError('No active workspace for this session.');
    }
    return { userId: user.id, workspaceId };
  }
}
