import { Controller, Patch, Body } from '@nestjs/common';
import { z } from 'zod';
import type { SessionUser } from '@voiceforge/shared';
import { RetentionService } from '../compliance/retention.service';
import { CurrentUser } from '../common/current-user.decorator';
import { SessionScoped } from '../common/decorators/session-scoped.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ForbiddenError, UnauthorizedError } from '../common/errors';

/**
 * The body used to be read straight off `@Body()` and clamped with
 * `Math.min(3650, Math.max(30, body.retentionDays ?? 365))`. There is no global
 * validation pipe on this app, so `retentionDays: "forever"` produced `NaN`,
 * survived both clamps unchanged, and was written to the workspace - after
 * which no call would ever be swept, because every comparison against `NaN` is
 * false. Rejecting outright is the only outcome that cannot silently disable
 * retention.
 *
 * The bounds are the same 30..3650 the clamp expressed, but stated as a
 * contract: out-of-range input is now a 400 rather than being silently
 * rewritten to a value the caller did not ask for. The 365 default is
 * preserved for an omitted field.
 */
export const UpdateRetentionSchema = z.object({
  retentionDays: z.number().int().min(30).max(3650).default(365),
});
export type UpdateRetentionDto = z.infer<typeof UpdateRetentionSchema>;

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
    @Body(new ZodValidationPipe(UpdateRetentionSchema)) body: UpdateRetentionDto,
  ) {
    if (!user?.id) throw new UnauthorizedError();
    const workspaceId = user.active_workspace_id;
    if (!workspaceId) throw new ForbiddenError('No active workspace for this session.');

    const days = body.retentionDays;
    await this.retention.updateWorkspaceRetention(workspaceId, days);
    return { success: true, retentionDays: days };
  }
}
