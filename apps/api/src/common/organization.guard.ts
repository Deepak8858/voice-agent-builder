import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { ForbiddenError, UnauthorizedError } from './errors';
import type { SessionUser } from '@voiceforge/shared';

const ORG_ACCESS_TTL_SECONDS = 300;

/**
 * Exported so CacheInvalidator deletes the same entry this guard writes.
 * A second spelling of the key would let a revoked user keep org access for
 * a full TTL window.
 */
export function orgAccessCacheKey(orgId: string, userId: string): string {
  return `org:access:${orgId}:${userId}`;
}

/**
 * Tenant check for routes keyed by `:orgId` rather than `:workspaceId`.
 *
 * `WorkspaceGuard` returns early when the route has no `:workspaceId` param, so
 * decorating an org-scoped route with it authenticates the caller but never
 * authorizes them against the tenant in the URL. Those routes need this guard
 * instead.
 *
 * Membership is modelled per workspace, not per organization, so org access is
 * derived: the caller must hold a membership in at least one workspace that
 * belongs to `:orgId`, or own the organization outright. Ownership is included
 * because an owner who has not yet joined a workspace would otherwise be locked
 * out of their own org.
 */
@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user;
    if (!user?.id) throw new UnauthorizedError();

    const orgId = req.params['orgId'];
    if (!orgId) {
      // Fail closed. A missing param means this guard was applied to a route it
      // cannot check, which is exactly the silent no-op it exists to prevent.
      throw new ForbiddenError('This route is not organization-scoped.');
    }

    const accessKey = orgAccessCacheKey(orgId, user.id);
    if (await this.cache.get<true>(accessKey)) return true;

    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id, workspace: { organizationId: orgId } },
      select: { id: true },
    });

    if (!membership) {
      const owned = await this.prisma.organization.findFirst({
        where: { id: orgId, ownerUserId: user.id },
        select: { id: true },
      });
      if (!owned) {
        throw new ForbiddenError('You do not have access to this organization.');
      }
    }

    await this.cache.set<true>(accessKey, true, ORG_ACCESS_TTL_SECONDS);
    return true;
  }
}
