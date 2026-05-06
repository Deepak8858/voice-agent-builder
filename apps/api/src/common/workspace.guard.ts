import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ForbiddenError, UnauthorizedError, WorkspaceNotFoundError } from './errors';
import type { SessionUser } from '@voiceforge/shared';

/**
 * Workspace-scoped auth check. The InternalAuthGuard runs first and
 * populates req.user from headers issued by the Next.js proxy. This
 * guard then verifies the caller is a member of the :workspaceId in
 * the URL and refines req.user with that workspace's role.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user;
    if (!user?.id) throw new UnauthorizedError();

    const workspaceId = req.params['workspaceId'];
    if (!workspaceId) {
      // Route not workspace-scoped; the InternalAuthGuard already accepted it.
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
