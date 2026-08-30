import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { REQUIRED_ORG_ROLE_KEY } from './decorators/required-org-role.decorator';
import type { WorkspaceRole } from './decorators/required-role.decorator';
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
 *
 * Membership alone is not authorization for an ADMINISTRATIVE org capability —
 * reading the org's whole audit log is one — so a route may narrow itself to a
 * seat allow-list with `@RequiredOrgRole(...)`, enforced below against the same
 * derivation. That belongs here rather than in RoleGuard, which cannot authorize
 * an `:orgId` route at all; see required-org-role.decorator.ts.
 */
@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    // Required, not @Optional(). An absent Reflector would make
    // @RequiredOrgRole metadata invisible and silently downgrade a role-gated
    // route to membership-only, which is the fail-open half of every
    // silent-no-op guard bug in this directory. Reflector is a core Nest
    // provider, so DI failing loudly at boot is the safe trade.
    private readonly reflector: Reflector,
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

    const roles = this.reflector.getAllAndOverride<readonly WorkspaceRole[] | undefined>(
      REQUIRED_ORG_ROLE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // Absent metadata means membership is enough — this guard is bound to routes
    // that legitimately need no seat, so failing closed here (as RoleGuard does)
    // would break them. An EMPTY list is the other thing: `@RequiredOrgRole()`
    // declares a gate and names nobody, so it must refuse rather than read as
    // applied while enforcing nothing.
    if (roles && roles.length === 0) {
      throw new ForbiddenError('This route is role-gated but declares no allowed roles.');
    }

    const accessKey = orgAccessCacheKey(orgId, user.id);
    // The cached entry is a bare `true` recording MEMBERSHIP, with no role in
    // it, so a role-gated route must never be served from it: an earlier
    // membership-only request by a viewer would otherwise satisfy an admin-only
    // route for the rest of the TTL. Skipping the read (rather than caching a
    // role) leaves the entry's shape alone for CacheInvalidator.
    if (!roles && (await this.cache.get<true>(accessKey))) return true;

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: user.id,
        workspace: { organizationId: orgId },
        ...(roles ? { role: { in: [...roles] } } : {}),
      },
      select: { id: true },
    });

    if (!membership) {
      const owned = await this.prisma.organization.findFirst({
        where: { id: orgId, ownerUserId: user.id },
        select: { id: true },
      });
      if (!owned) {
        throw new ForbiddenError(
          roles
            ? 'Your role in this organization does not permit this action.'
            : 'You do not have access to this organization.',
        );
      }
    }

    await this.cache.set<true>(accessKey, true, ORG_ACCESS_TTL_SECONDS);
    return true;
  }
}
