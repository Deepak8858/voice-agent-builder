import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAuthService } from '../auth/supabase-auth.service';
import { env } from '../config/env';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: SupabaseAuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user ?? await this.resolveSessionUser(req);
    if (!user?.id) throw new UnauthorizedError();
    req.user = user;

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

  private async resolveSessionUser(req: Request): Promise<SessionUser | null> {
    const expected = env.INTERNAL_API_KEY;
    const provided = headerString(req, 'x-internal-key');

    if (!expected || !provided || provided !== expected) {
      throw new UnauthorizedError();
    }

    return this.authService.getSessionUser(req);
  }
}

function headerString(req: Request, key: string): string | null {
  const v = req.headers[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return null;
}
