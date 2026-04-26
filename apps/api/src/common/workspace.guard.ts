import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { ForbiddenError, UnauthorizedError, WorkspaceNotFoundError } from './errors';
import type { SessionUser } from '@voiceforge/shared';

/**
 * Enforces two invariants on every workspace-scoped route:
 * 1. The request carries a valid session.
 * 2. The session user is a member of the :workspaceId in the URL.
 *
 * Sets `req.user` to the authenticated SessionUser for downstream handlers.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = await this.auth.getSessionUser(req);
    if (!user) throw new UnauthorizedError();

    const workspaceId = req.params['workspaceId'];
    if (!workspaceId) {
      // Route not workspace-scoped; only auth required.
      req.user = user;
      return true;
    }

    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);

    const membership = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!membership) throw new ForbiddenError('You are not a member of this workspace.');

    req.user = {
      ...user,
      active_workspace_id: ws.id,
      active_workspace_name: ws.name,
      active_workspace_role: membership.role as SessionUser['active_workspace_role'],
    };
    return true;
  }
}
