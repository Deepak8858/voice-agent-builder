import { Controller, Get } from '@nestjs/common';
import { Request } from 'express';
import { Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

@Controller('auth')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Get('me')
  async me(@Req() req: Request) {
    const authUserId = req.headers['x-user-id'] as string;
    const email = req.headers['x-user-email'] as string;

    if (!authUserId) {
      return {
        id: null,
        email: '',
        name: null,
        active_workspace_id: null,
        active_workspace_name: null,
        active_workspace_role: 'viewer',
      };
    }

    // Build session user and provision workspace if needed
    const sessionUser = await this.provisionWorkspace(authUserId, email);

    const memberships = await this.prisma.membership.findMany({
      where: { userId: sessionUser?.id },
      include: { workspace: { select: { id: true, name: true, slug: true, type: true } } },
    });

    // Return first membership as active workspace (like SupabaseAuthService does)
    const activeMembership = memberships[0];
    return {
      id: sessionUser?.id ?? authUserId,
      email: email ?? sessionUser?.email ?? '',
      name: sessionUser?.name ?? null,
      active_workspace_id: activeMembership?.workspace.id ?? null,
      active_workspace_name: activeMembership?.workspace.name ?? null,
      active_workspace_role: (activeMembership?.role as 'owner' | 'admin' | 'editor' | 'viewer') ?? 'owner',
    };
  }

  private async provisionWorkspace(authUserId: string, email?: string) {
    const cacheKey = `session:user:${authUserId}`;
    const cached = await this.cache.get<{ id: string; email: string; name: string | null }>(cacheKey);
    if (cached) return cached;

    const user = await this.prisma.user.findUnique({ where: { authUserId } });
    if (!user) {
      // User doesn't exist - this shouldn't happen with proper auth flow
      return null;
    }

    // Check if user has any workspace memberships
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      include: { workspace: true },
    });

    if (!membership) {
      // Provision personal workspace
      const orgSlug = `user-${authUserId.slice(0, 8)}`;
      const organization = await this.prisma.organization.upsert({
        where: { slug: orgSlug },
        create: { slug: orgSlug, name: 'Personal', ownerUserId: user.id },
        update: {},
      });

      let workspace = await this.prisma.workspace.findFirst({
        where: { organizationId: organization.id },
      });
      if (!workspace) {
        workspace = await this.prisma.workspace.create({
          data: { organizationId: organization.id, name: 'Demo Workspace', slug: 'demo', type: 'direct' },
        });
      }

      await this.prisma.membership.upsert({
        where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
        create: { userId: user.id, workspaceId: workspace.id, role: 'owner' },
        update: {},
      });
    }

    await this.cache.set(cacheKey, user, 300);
    return user;
  }
}