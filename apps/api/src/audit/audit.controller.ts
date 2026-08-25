import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../common/workspace.guard';

// Audit logs are the record of who did what inside a tenant, so an unguarded
// read here is a disclosure of another tenant's activity. The `workspaceId`
// predicate below is only meaningful once membership in the URL's workspace has
// been verified.
@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('action') action: string | undefined,
  ) {
    const take = Math.min(parseInt(limit ?? '20', 10), 100);
    const where: Prisma.AuditLogWhereInput = { workspaceId };
    if (action) where.action = { contains: action, mode: 'insensitive' };
    const logs = await this.prisma.auditLog.findMany({
      where,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { email: true, name: true } } },
    });
    const hasMore = logs.length > take;
    const items = hasMore ? logs.slice(0, -1) : logs;
    return { items, next_cursor: hasMore ? items[items.length - 1].id : null };
  }
}