import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const BATCH_SIZE = 5000;

interface SweepResult {
  deleted: number;
  remaining: number;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  computeExpiresAt(createdAt: Date, retentionDays: number): Date {
    return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  }

  async setExpiresAt(callId: string, retentionDays: number): Promise<void> {
    const call = await this.prisma.call.findUnique({ where: { id: callId }, select: { createdAt: true } });
    if (!call) return;
    const expiresAt = this.computeExpiresAt(call.createdAt, retentionDays);
    await this.prisma.call.update({
      where: { id: callId },
      data: { expiresAt, retentionDays },
    });
  }

  async sweepExpiredCalls(): Promise<SweepResult> {
    const now = new Date();

    // Count remaining before delete
    const remaining = await this.prisma.call.count({
      where: { expiresAt: { lt: now } },
    });

    if (remaining === 0) {
      return { deleted: 0, remaining: 0 };
    }

    // Delete in batches to avoid lock contention
    const result = await this.prisma.call.deleteMany({
      where: {
        expiresAt: { lt: now },
        id: { in: (await this.prisma.call.findMany({
          where: { expiresAt: { lt: now } },
          take: BATCH_SIZE,
          orderBy: { expiresAt: 'asc' },
          select: { id: true },
        })).map(c => c.id) },
      },
    });

    const deleted = result.count;
    const afterRemaining = await this.prisma.call.count({
      where: { expiresAt: { lt: now } },
    });

    this.logger.log({ deleted, remaining: afterRemaining }, 'Retention sweep completed');
    return { deleted, remaining: afterRemaining };
  }

  async updateWorkspaceRetention(workspaceId: string, retentionDays: number): Promise<void> {
    const clamped = Math.min(3650, Math.max(30, retentionDays));
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { retentionDays: clamped },
    });
  }
}