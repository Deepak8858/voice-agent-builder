import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { CacheService } from '../cache/cache.service';
import { UnauthorizedError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

interface WorkspaceListItem {
  id: string;
  name: string;
  slug: string;
  role: string;
  type: string;
  organization_id: string;
  is_active: boolean;
}

@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Get('workspaces')
  async listWorkspaces(
    @Req() req: Request & { user?: SessionUser },
  ): Promise<{ items: WorkspaceListItem[] }> {
    const user = req.user;
    if (!user) throw new UnauthorizedError();
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    const items = memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
      type: m.workspace.type,
      organization_id: m.workspace.organizationId,
      is_active: m.workspace.id === user.active_workspace_id,
    }));
    return { items };
  }

  @Post('active-workspace')
  async setActiveWorkspace(
    @Req() req: Request & { user?: SessionUser },
    @Body() body: { workspace_id?: string },
  ): Promise<{ active_workspace_id: string }> {
    const user = req.user;
    if (!user) throw new UnauthorizedError();
    const wsId = body?.workspace_id;
    if (!wsId) throw new BadRequestException('workspace_id is required');

    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: wsId },
      include: { workspace: true },
    });
    if (!membership) throw new BadRequestException('You are not a member of that workspace');

    // Update the cached SessionUser so subsequent requests see the new active workspace.
    const updated: SessionUser = {
      ...user,
      active_workspace_id: membership.workspace.id,
      active_workspace_name: membership.workspace.name,
      active_workspace_role: membership.role as SessionUser['active_workspace_role'],
    };
    // Cache key matches buildSessionUser in clerk-auth.service.ts.
    await this.cache.set(`session:workspace:${user.id}`, updated, 300);
    await this.cache.del(`session:user:${user.id}`).catch(() => undefined);

    return { active_workspace_id: membership.workspace.id };
  }
}
