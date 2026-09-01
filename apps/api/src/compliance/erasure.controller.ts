import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';
import { ErasureService } from './erasure.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { SessionScoped } from '../common/decorators/session-scoped.decorator';
import { RoleGuard } from '../common/role.guard';
import { ForbiddenError, UnauthorizedError } from '../common/errors';

/**
 * `main.ts` already sets the global prefix `api/v1`, so the `v1/` these two
 * handler paths carried served them at `/api/v1/v1/...` — the same doubled
 * namespace fixed in SettingsController (CS-40). Dropping it has one behaviour
 * consequence worth stating: `workspaces/me/contacts/:contactId/erasure` now
 * sits under the `/workspaces` prefix the web proxy allow-lists, so it is
 * reachable from the browser where the doubled path was not. That is the
 * intended state — it is tenant self-service scoped to the session's
 * `active_workspace_id`, and ContactsController's sibling contact mutations are
 * already reachable the same way. `users/me/erasure` is browser-reachable too:
 * the settings page's delete-account flow is its client, and the proxy
 * allow-lists exactly `/users/me/erasure`, not a `/users` prefix.
 *
 * Neither path can be captured by another controller: no route under
 * `workspaces/:workspaceId` serves DELETE at five segments, and nothing else
 * mounts a `users` prefix.
 */
@Controller()
export class ErasureController {
  constructor(private readonly erasure: ErasureService) {}

  /**
   * Contact erasure, scoped to the caller's own workspace.
   *
   * This route was previously `DELETE v1/orgs/:orgId/contacts/:contactId/erasure`
   * decorated with `WorkspaceGuard`. That guard only checks a `:workspaceId`
   * param, so with `:orgId` in the path it returned early and performed no
   * tenant check whatsoever. `ErasureService.eraseContact` treats its first
   * argument as a `workspaceId`, so any authenticated user could pass another
   * tenant's workspace id and permanently delete that tenant's contact along
   * with its cascaded calls, consent records, compliance checks, analytics
   * events, evaluations and tool invocations.
   *
   * The path param is removed rather than guarded: the tenant now comes from
   * `active_workspace_id`, which the global `InternalAuthGuard` derives from a
   * verified Supabase token, so the caller cannot choose it. There is no reason
   * for a client to name the tenant on a destructive self-service endpoint when
   * the session already identifies it. Nothing in `apps/web` called the old path.
   */
  @Delete('workspaces/me/contacts/:contactId/erasure')
  // Becoming browser-reachable made the missing role gate live: erasure
  // permanently destroys the contact and everything cascaded from it, so a
  // viewer must not be able to trigger it. Same stack and fresh-read reasoning
  // as SettingsController.updateRetention and the knowledge destructive routes.
  @SessionScoped()
  @UseGuards(RoleGuard)
  @RequiredRole(['owner', 'admin'], { fresh: true })
  async eraseContact(
    @CurrentUser() user: SessionUser | undefined,
    @Param('contactId') contactId: string,
  ) {
    return this.erasure.eraseContact(this.requireWorkspace(user), contactId);
  }

  // Organization deletion: internal admin only. The proxy attaches the
  // internal key to any path a signed-in user requests, so authentication
  // alone would let a tenant user delete an arbitrary organization by id.
  // @InternalOnly() refuses any request that carries user context.
  @InternalOnly()
  @Delete('admin/orgs/:orgId')
  @UseGuards(InternalAuthGuard)
  async eraseOrganization(@Param('orgId') orgId: string) {
    return this.erasure.eraseOrganization(orgId);
  }

  // User self-deletion. The user id comes from the verified session, never the
  // path, so there is no cross-user surface to guard.
  @Delete('users/me/erasure')
  async eraseUser(@CurrentUser() user: SessionUser | undefined) {
    if (!user?.id) throw new UnauthorizedError();
    return this.erasure.eraseUser(user.id);
  }

  private requireWorkspace(user: SessionUser | undefined): string {
    if (!user?.id) throw new UnauthorizedError();
    const workspaceId = user.active_workspace_id;
    if (!workspaceId) throw new ForbiddenError('No active workspace for this session.');
    return workspaceId;
  }
}
