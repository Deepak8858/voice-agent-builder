import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { CacheInvalidator } from '../common/cache-invalidator';
import { workspaceListCacheKey } from '../common/cache-keys';
import { WorkspaceNotFoundError } from '../common/errors';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly invalidator: CacheInvalidator,
  ) {}

  async listForUser(userId: string) {
    return this.cache.readThrough(
      workspaceListCacheKey(userId),
      300,
      () => this.listForUserLoader(userId),
    );
  }

  private async listForUserLoader(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      organization_id: m.workspace.organizationId,
      name: m.workspace.name,
      slug: m.workspace.slug,
      type: m.workspace.type,
      status: m.workspace.status,
      role: m.role,
      created_at: m.workspace.createdAt.toISOString(),
      updated_at: m.workspace.updatedAt.toISOString(),
    }));
  }

  async get(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);
    return {
      id: ws.id,
      organization_id: ws.organizationId,
      parent_workspace_id: ws.parentWorkspaceId,
      name: ws.name,
      slug: ws.slug,
      type: ws.type,
      status: ws.status,
      created_at: ws.createdAt.toISOString(),
      updated_at: ws.updatedAt.toISOString(),
    };
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    patch: { name?: string },
  ) {
    const ws = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { ...(patch.name ? { name: patch.name } : {}) },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'workspace.update',
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: patch,
    });
    // A rename is visible to every member, not just the actor: their sidebar
    // list, the workspace:access entry WorkspaceGuard stamps into req.user,
    // and BOTH session snapshots all cache the old name. There are two session
    // keys — session:user:<authUserId> and session:workspace:<userId> — and
    // getSessionUser returns the subject-keyed one first, so clearing only the
    // workspace-keyed one leaves the stale name live for a full TTL.
    const members = await this.prisma.membership.findMany({
      where: { workspaceId },
      select: { userId: true, user: { select: { authUserId: true } } },
    });
    for (const { userId, user } of members) {
      await this.invalidator.invalidateWorkspaceList(userId);
      await this.invalidator.invalidateWorkspaceAccess(workspaceId, userId);
      await this.invalidator.invalidateSession({
        appUserId: userId,
        supabaseUserId: user?.authUserId ?? undefined,
      });
    }
    return ws;
  }
}
