import { Controller, Get, Param, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
    const where: any = { workspaceId };
    if (action) where.action = { contains: action, mode: 'insensitive' };
    const logs = await this.prisma.auditLog.findMany({
      where,
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, name: true } } },
    });
    const hasMore = logs.length > take;
    const items = hasMore ? logs.slice(0, -1) : logs;
    return { items, next_cursor: hasMore ? items[items.length - 1].id : null };
  }
}