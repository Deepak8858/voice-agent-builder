import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly orgCache = new Map<string, string>();

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Resolve organization_id for a workspace with a short-lived in-memory cache. */
  async organizationIdFor(workspaceId: string): Promise<string> {
    const cached = this.orgCache.get(workspaceId);
    if (cached) return cached;
    const ws = await this.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    this.orgCache.set(workspaceId, ws.organizationId);
    return ws.organizationId;
  }

  clearOrgCache(workspaceId?: string): void {
    if (workspaceId) this.orgCache.delete(workspaceId);
    else this.orgCache.clear();
  }
}
