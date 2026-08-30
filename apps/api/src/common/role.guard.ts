import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import {
  REQUIRED_ROLE_KEY,
  RequiredRoleMetadata,
  WorkspaceRole,
} from './decorators/required-role.decorator';
import { CachedWorkspaceAccess, workspaceAccessCacheKey } from './workspace.guard';
import { ForbiddenError, UnauthorizedError } from './errors';

/**
 * Enforces the `@RequiredRole(...)` allow-list. Bind it per-controller AFTER
 * WorkspaceGuard (`@UseGuards(WorkspaceGuard, RoleGuard)`) — membership in the
 * target workspace is WorkspaceGuard's job; this guard only decides whether
 * that member's role is on the route's list. It is never registered as an
 * APP_GUARD: most routes are open to every member, and a global role gate
 * would need an opt-out on each of them, which is how silent-no-op guards
 * happen.
 *
 * The role is RE-RESOLVED from the membership row (or the workspace-access
 * cache WorkspaceGuard shares) rather than read off
 * `req.user.active_workspace_role`. That field is only authoritative after
 * WorkspaceGuard has matched it against a `:workspaceId` param; on
 * @SessionScoped() routes it is whatever `buildSessionUser` cached — the
 * caller's OLDEST membership by createdAt, which may be an `owner` seat in
 * some unrelated personal workspace while their seat in the workspace this
 * request actually targets is `viewer`. Trusting the field there is a
 * privilege escalation, so we look the membership up for the request's real
 * target: the `:workspaceId` param when present, `active_workspace_id`
 * otherwise.
 *
 * That fallback is only correct on `:workspaceId` routes and on
 * @SessionScoped() routes, which have no tenant in the path at all — see
 * FOREIGN_TENANT_PARAMS.
 */

/**
 * Tenant params this guard cannot authorize. On a route keyed by one of these,
 * the `active_workspace_id` fallback would check the caller's role in their
 * SESSION workspace while the handler acts on the tenant named in the path:
 * a role check that reads as applied in review and enforces nothing. Refusing
 * is the only safe answer, since resolving an org- or client-scoped role is a
 * different lookup than the membership row.
 */
const FOREIGN_TENANT_PARAMS = ['organizationId', 'orgId', 'clientId'] as const;
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredRoleMetadata | undefined>(
      REQUIRED_ROLE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // Fail closed. A RoleGuard bound without @RequiredRole() is the same
    // misconfiguration WorkspaceGuard used to allow for missing params: a
    // guard that looks applied in review while enforcing nothing.
    if (!required || required.roles.length === 0) {
      throw new ForbiddenError('This route is role-gated but declares no allowed roles.');
    }

    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user;
    if (!user?.id) throw new UnauthorizedError();

    const params = req.params ?? {};
    const foreign = params['workspaceId']
      ? undefined
      : FOREIGN_TENANT_PARAMS.find((name) => params[name]);
    if (foreign) {
      throw new ForbiddenError(
        `RoleGuard cannot authorize a route keyed by :${foreign}; it resolves workspace roles only.`,
      );
    }

    const workspaceId = params['workspaceId'] ?? user.active_workspace_id;
    if (!workspaceId) throw new ForbiddenError('No target workspace to check a role against.');

    const role = await this.resolveRole(workspaceId, user.id, required.fresh);
    if (!role || !required.roles.includes(role)) {
      throw new ForbiddenError('Your workspace role does not permit this action.');
    }
    return true;
  }

  private async resolveRole(
    workspaceId: string,
    userId: string,
    fresh: boolean,
  ): Promise<WorkspaceRole | null> {
    if (!fresh) {
      const cached = await this.cache.get<CachedWorkspaceAccess>(
        workspaceAccessCacheKey(workspaceId, userId),
      );
      if (cached?.role) return cached.role;
    }
    // On a cache miss we read the row but leave populating the cache to
    // WorkspaceGuard, whose entry also needs the workspace name; caching a
    // partial entry here would poison its shape.
    const membership = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    });
    return (membership?.role as WorkspaceRole | undefined) ?? null;
  }
}
