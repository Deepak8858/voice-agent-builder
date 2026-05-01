import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { PrismaService } from '../prisma/prisma.service';

interface AuditLogResponse {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  metadata: unknown;
  created_at: string;
}

@Controller('workspaces/:workspaceId/audit-logs')
@UseGuards(WorkspaceGuard)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('resource_type') resourceType?: string,
  ): Promise<{ items: AuditLogResponse[]; next_cursor: string | null }> {
    const take = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        workspaceId,
        ...(action ? { action: { contains: action } } : {}),
        ...(resourceType ? { resourceType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { actor: { select: { email: true } } },
    });

    const hasMore = rows.length > take;
    const items = (hasMore ? rows.slice(0, take) : rows).map((r) => ({
      id: r.id,
      action: r.action,
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      actor_user_id: r.actorUserId,
      actor_email: r.actor?.email ?? null,
      metadata: r.metadata,
      created_at: r.createdAt.toISOString(),
    }));
    return {
      items,
      next_cursor: hasMore ? items[items.length - 1]!.id : null,
    };
  }
}
