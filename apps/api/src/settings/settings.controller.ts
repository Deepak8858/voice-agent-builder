import { Controller, Patch, Body, UseGuards } from '@nestjs/common';
import { RetentionService } from '../compliance/retention.service';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('v1/workspaces')
export class SettingsController {
  constructor(private readonly retention: RetentionService) {}

  @Patch('me/retention')
  @UseGuards(WorkspaceGuard)
  async updateRetention(
    @CurrentUser() user: { active_workspace_id: string },
    @Body() body: { retentionDays: number },
  ) {
    const days = Math.min(3650, Math.max(30, body.retentionDays ?? 365));
    await this.retention.updateWorkspaceRetention(user.active_workspace_id, days);
    return { success: true, retentionDays: days };
  }
}