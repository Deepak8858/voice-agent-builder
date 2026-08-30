import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAuthService } from '../auth/supabase-auth.service';
import { CacheService } from '../cache/cache.service';
import { env } from '../config/env';
import { IS_SESSION_SCOPED_KEY } from './decorators/session-scoped.decorator';
import { ForbiddenError, UnauthorizedError, WorkspaceNotFoundError } from './errors';
import { constantTimeEqual } from './secure-compare';
import type { SessionUser } from '@voiceforge/shared';

const WORKSPACE_ACCESS_TTL_SECONDS = 300;

export interface CachedWorkspaceAccess {
  id: string;
  name: string;
  role: SessionUser['active_workspace_role'];
}

/**
 * Exported so RoleGuard reads the same cache entry this guard writes. Two
 * separately-formatted keys for the same membership fact would let the two
 * guards disagree about a caller's role for up to a full TTL window.
 */
export function workspaceAccessCacheKey(workspaceId: string, userId: string): string {
  return `workspace:access:${workspaceId}:${userId}`;
}

/**
 * Workspace-scoped auth check. The InternalAuthGuard runs first and
 * populates req.user from headers issued by the Next.js proxy. This
 * guard then verifies the caller is a member of the :workspaceId in
 * the URL and refines req.user with that workspace's role.
 *
 * This guard only authorizes routes that carry a `:workspaceId` path param. It
 * used to `return true` for any other route, which made it a silent no-op
 * wherever it was applied to a route keyed by a differently-named param — the
 * route looked guarded in review but performed no tenant check at all. It now
 * refuses instead. Routes keyed by `:orgId` belong to `OrganizationGuard`;
 * routes that derive their tenant from `active_workspace_id` need no guard here
 * because the global InternalAuthGuard already populates it from a verified
 * token, and must opt out explicitly with @SessionScoped().
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: SupabaseAuthService,
    private readonly cache: CacheService,
    private readonly reflector?: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user ?? await this.resolveSessionUser(req);
    if (!user?.id) throw new UnauthorizedError();
    req.user = user;

    const workspaceId = req.params['workspaceId'];
    if (!workspaceId) {
      // Fail closed. Silently accepting here is what turned this guard into
      // decoration on routes whose tenant param is named something else.
      if (this.isSessionScoped(ctx)) return true;
      throw new ForbiddenError('This route is not workspace-scoped.');
    }

    const accessKey = workspaceAccessCacheKey(workspaceId, user.id);
    const cached = await this.cache.get<CachedWorkspaceAccess>(accessKey);
    if (cached) {
      req.user = {
        ...user,
        active_workspace_id: cached.id,
        active_workspace_name: cached.name,
        active_workspace_role: cached.role,
      };
      return true;
    }

    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);

    const membership = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!membership) throw new ForbiddenError('You are not a member of this workspace.');

    const role = membership.role as SessionUser['active_workspace_role'];
    await this.cache.set<CachedWorkspaceAccess>(
      accessKey,
      { id: ws.id, name: ws.name, role },
      WORKSPACE_ACCESS_TTL_SECONDS,
    );

    req.user = {
      ...user,
      active_workspace_id: ws.id,
      active_workspace_name: ws.name,
      active_workspace_role: role,
    };
    return true;
  }

  private async resolveSessionUser(req: Request): Promise<SessionUser | null> {
    const expected = env.INTERNAL_API_KEY;
    const provided = headerString(req, 'x-internal-key');

    // Same comparison as InternalAuthGuard. A plain `!==` here leaked the key
    // one prefix byte at a time to anyone who could time this path, which
    // undermined the constant-time check on the guard in front of it.
    if (!expected || !provided || !constantTimeEqual(provided, expected)) {
      throw new UnauthorizedError();
    }

    return this.authService.getSessionUser(req);
  }

  /**
   * True when the handler or its controller declares that it takes its tenant
   * from the session rather than the path, via @SessionScoped().
   */
  private isSessionScoped(ctx: ExecutionContext): boolean {
    return this.reflector?.getAllAndOverride<boolean>(IS_SESSION_SCOPED_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) === true;
  }
}

function headerString(req: Request, key: string): string | null {
  const v = req.headers[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return null;
}
