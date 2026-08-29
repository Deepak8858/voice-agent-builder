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
    // A retention change has to reach the calls already recorded. Without the
    // re-stamp below, shortening the period only affects calls created after
    // it: the older recordings and transcripts the shortening was meant to
    // purge keep their original, longer expires_at and are never swept.
    //
    // expires_at is per-call `created_at + retention_days`, and Prisma has no
    // way to reference another column in an update, so the re-stamp is one
    // parameterised raw UPDATE. It is workspace-scoped in its WHERE and passes
    // the day count and the workspace id as bound parameters; the tenant-scope
    // analyzer cannot see raw SQL, so this scoping is verified by hand and by
    // the isolation test in retention.service.test.ts.
    //
    // created_at is timestamp(3) (no zone) while expires_at is timestamptz, so
    // `AT TIME ZONE 'UTC'` makes the bridge explicit instead of relying on the
    // session TimeZone, matching what computeExpiresAt does in JS.
    //
    // Both statements share one transaction: if the re-stamp fails the setting
    // rolls back with it, so the workspace never advertises a period its stored
    // calls do not honour, and a request that errored never leaves calls
    // shortened.
    //
    // ponytail: one unbounded UPDATE holds row locks for the whole workspace's
    // calls. Upgrade path if that lock ever matters: batch by a created_at
    // keyset like sweepExpiredCalls batches — at the cost of atomicity with the
    // workspace row, which is why it is one statement today.
    const [, restamped] = await this.prisma.$transaction([
      this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { retentionDays: clamped },
      }),
      this.prisma.$executeRaw`
        UPDATE calls
           SET expires_at = (created_at AT TIME ZONE 'UTC') + (${clamped}::int * INTERVAL '1 day'),
               retention_days = ${clamped}::int
         WHERE workspace_id = ${workspaceId}::uuid
      `,
    ]);
    // Shortening can make rows immediately expired, so the next sweep deletes
    // them. Log the blast radius: the change is destructive and irreversible.
    this.logger.log({ workspaceId, retentionDays: clamped, restamped }, 'Workspace retention updated');
  }
}