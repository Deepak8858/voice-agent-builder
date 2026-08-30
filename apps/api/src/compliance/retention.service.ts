import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const BATCH_SIZE = 5000;

interface SweepResult {
  deleted: number;
  remaining: number;
}

/**
 * Tenant scope for one sweep run. An absent `workspaceId` means every
 * workspace, which a retention sweep legitimately needs, so that mode stays
 * available -- but it is now one branch of two and it is named in the audit row
 * either way, instead of being the only thing the method can do.
 */
interface SweepScope {
  workspaceId?: string;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * Deletes up to BATCH_SIZE calls whose retention period has elapsed,
   * longest-expired first, and records what was destroyed.
   *
   * The scope is spread in from a parameter rather than written as a conditional
   * tenant predicate in the `where` literal, deliberately: the tenant-scope
   * analyzer reads the literal text, so an inline `...(workspaceId ? {
   * workspaceId } : {})` would make it call the platform-wide mode "scoped" and
   * quietly drop the most destructive query in this codebase out of the reviewed
   * baseline. Unscoped is what this really is when no workspace is given, so it
   * stays flagged and stays reviewed.
   */
  async sweepExpiredCalls(scope: SweepScope = {}): Promise<SweepResult> {
    const now = new Date();
    const where = { expiresAt: { lt: now }, ...scope };

    const remaining = await this.prisma.call.count({ where });

    if (remaining === 0) {
      return { deleted: 0, remaining: 0 };
    }

    // One batch per run bounds the lock footprint and the size of the audit row.
    const doomed = await this.prisma.call.findMany({
      where,
      take: BATCH_SIZE,
      orderBy: { expiresAt: 'asc' },
      select: { id: true },
    });
    const callIds = doomed.map(c => c.id);

    // `where` is repeated next to the id list on purpose, not redundantly: a
    // concurrent updateWorkspaceRetention can lengthen a call's expires_at
    // between these two statements, and re-asserting the predicate stops a call
    // that has just stopped being expired from being deleted anyway.
    const result = await this.prisma.call.deleteMany({
      where: { ...where, id: { in: callIds } },
    });

    const deleted = result.count;
    const afterRemaining = await this.prisma.call.count({ where });

    // Local log first. The audit insert can fail, and the only record of an
    // irreversible bulk delete must not fail with it.
    this.logger.log({ scope, deleted, remaining: afterRemaining }, 'Retention sweep completed');
    // After the delete, never before: an audit row must not claim a deletion
    // that did not happen. The two cannot share a transaction (AuditService
    // holds its own client) and Postgres aborts a transaction on the first
    // failed statement, so there is no catch-and-recover ordering that beats
    // this -- a failed audit insert surfaces as a failed request, on top of the
    // log line above.
    await this.audit.log({
      workspaceId: scope.workspaceId ?? null,
      action: 'retention.sweep',
      resourceType: 'call',
      metadata: {
        // 'all-workspaces' is spelled out rather than left as a missing key, so
        // a cross-tenant purge cannot be mistaken for a row with lost scope.
        scope: scope.workspaceId ?? 'all-workspaces',
        cutoff: now.toISOString(),
        deleted,
        remaining: afterRemaining,
        // The ids, not only the count: this row is the sole surviving record
        // that a specific recording and transcript were destroyed, and it is
        // what answers "was call X purged, and when". One row per run rather
        // than per call -- a full batch would otherwise write 5000 audit rows.
        // `deleted` can be lower than this list if something else removed a row
        // first; that gap is itself worth seeing.
        // ponytail: up to BATCH_SIZE ids (~200KB of jsonb) in one row. Upgrade
        // path if that ever hurts: a dedicated purge-manifest table.
        callIds,
      },
    });
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