import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';

// Audit logs are the record of who did what inside a tenant, so an unguarded
// read here is a disclosure of another tenant's activity. The `workspaceId`
// predicate below is only meaningful once membership in the URL's workspace has
// been verified.
//
// Membership is not enough. Every row names its actor by email, and
// who-did-what inside a tenant is administrative data — same bar as
// billing (`billing.controller.ts:38-43`).
@UseGuards(WorkspaceGuard, RoleGuard)
@RequiredRole('owner', 'admin')
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
    // `parseInt` gives NaN on junk and a negative on `?limit=-2`; a negative
    // `take` makes Prisma page backwards, which returned one row for a
    // zero-length page and then crashed on `items[-1].id`.
    const take = Math.min(Math.max(parseInt(limit ?? '20', 10) || 20, 1), 100);
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