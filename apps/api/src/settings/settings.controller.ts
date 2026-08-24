import { Controller, Patch, Body } from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';
import { RetentionService } from '../compliance/retention.service';
import { CurrentUser } from '../common/current-user.decorator';
import { SessionScoped } from '../common/decorators/session-scoped.decorator';
import { ForbiddenError, UnauthorizedError } from '../common/errors';

@Controller('v1/workspaces')
export class SettingsController {
  constructor(private readonly retention: RetentionService) {}

  /**
   * `WorkspaceGuard` was applied here but `me/retention` has no `:workspaceId`
   * param, so the guard returned early without checking anything. The route was
   * safe in effect because it already reads the tenant from the session, but the
   * guard was decoration that made review harder. @SessionScoped() states the
   * actual contract instead.
   *
   * `active_workspace_id` is nullable, and the previous signature typed it as a
   * plain `string`, so a session with no active workspace would have written
   * retention against `undefined`.
   */
  @Patch('me/retention')
  @SessionScoped()
  async updateRetention(
    @CurrentUser() user: SessionUser | undefined,
    @Body() body: { retentionDays: number },
  ) {
    if (!user?.id) throw new UnauthorizedError();
    const workspaceId = user.active_workspace_id;
    if (!workspaceId) throw new ForbiddenError('No active workspace for this session.');

    const days = Math.min(3650, Math.max(30, body.retentionDays ?? 365));
    await this.retention.updateWorkspaceRetention(workspaceId, days);
    return { success: true, retentionDays: days };
  }
}
