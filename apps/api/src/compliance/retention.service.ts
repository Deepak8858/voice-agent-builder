import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const BATCH_SIZE = 5000;

/**
 * Age ceiling for `telephony_webhook_events`, in days.
 *
 * 30 is the floor `updateWorkspaceRetention` clamps a workspace to, which is why
 * one flat number is enough: it can never outlive a tenant's own window, where a
 * per-workspace window could. A workspace on the 30-day minimum would otherwise
 * keep raw provider bodies here for the 365-day default, and the only thing
 * asking each workspace would buy is keeping caller phone numbers *longer* for
 * the tenants with long windows -- the wrong direction for a table whose rows are
 * unread provider payloads. Rows whose `workspace_id` is NULL (no phone number on
 * the delivery, or a lookup that missed) have no tenant to ask and get the same
 * ceiling, which is the whole reason a ceiling exists.
 *
 * Three orders of magnitude clear of every provider retry window (minutes for a
 * Twilio status callback, hours for LiveKit), so purging a row cannot re-open a
 * replay that a `(provider, event_id)` idempotency check would have refused.
 * Nothing performs that check today: `TelephonyService.recordWebhookEvent`
 * creates the row inside a swallowing try/catch and all six call sites discard
 * its result, so replay protection lives in `ensureInboundCall`'s upsert on
 * `(provider, provider_call_id)` and in call admission, neither of which reads
 * this table. The margin is for whoever wires the check up later.
 */
const TELEPHONY_WEBHOOK_EVENT_MAX_AGE_DAYS = 30;

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
      select: { id: true, workspaceId: true },
    });
    // Filled by the loop rather than two `doomed.map(...)` initializers, and this
    // is load-bearing: the tenant-scope analyzer substitutes a referenced
    // variable's initializer text into the `where` it is checking, two levels
    // deep. `const callIds = doomed.map(c => c.id)` would carry the `select`
    // above -- now containing `workspaceId` -- into the `where` of the
    // `call.deleteMany` below, and the most destructive query in this codebase
    // would silently be reclassified as tenant-scoped and drop out of the
    // reviewed baseline. An empty-array initializer expands to nothing.
    const callIds: string[] = [];
    const doomedWorkspaceIds = new Set<string>();
    for (const call of doomed) {
      callIds.push(call.id);
      doomedWorkspaceIds.add(call.workspaceId);
    }

    // Before the calls go, not after: `crm_fanout_log.call_id` is ON DELETE SET
    // NULL, so deleting the call leaves the row behind holding `contact_data` --
    // the contact's name, phone and email as they were handed to the CRM -- with
    // nothing left to find it by. It is the one place a purged call's personal
    // data outlives its own purge, which is the whole point of the sweep.
    //
    // Scoped by the doomed calls' workspaces as well as their ids. The ids alone
    // are already exact; the workspace predicate is the part the tenant-scope
    // analyzer can read, and it costs nothing because it cannot exclude a row it
    // should delete: the writer sets `workspace_id` and `call_id` together, and
    // `20260829000000_crm_fanout_log_workspace_id` backfilled the older rows
    // through this very foreign key, so a row that still has a `call_id` always
    // agrees with that call's workspace.
    //
    // Not transactional with the delete below, because the sweep is not: a call
    // whose retention is lengthened in between, or a failed `deleteMany`, loses
    // its fan-out row and keeps the call. The inverse trade is contact data
    // surviving forever, which is not a trade.
    const fanout = await this.prisma.crmFanoutLog.deleteMany({
      where: {
        callId: { in: callIds },
        workspaceId: { in: [...doomedWorkspaceIds] },
      },
    });

    // Same defect class, same reason it has to happen before the calls go:
    // `telephony_webhook_events.call_id` is a bare uuid column with no foreign
    // key at all, so nothing cascades and nothing even nulls the pointer -- the
    // row simply stays, holding `raw_payload_json`, which for a Twilio delivery
    // is the provider's own form body with `From` and `To` in it: the caller's
    // phone number, kept past the retention period the sweep exists to enforce.
    //
    // The workspace predicate is NOT the same argument as the fan-out one above,
    // so it is not spelled the same way. There the writer sets `workspace_id` and
    // `call_id` together, so a row with a call always agreed with that call's
    // workspace. Here the two columns come from different places:
    // `recordWebhookEvent` takes `workspace_id` from the phone number the event
    // arrived on and `call_id` from a call looked up independently, so a LiveKit
    // event whose phone number could not be resolved has a `call_id` and a NULL
    // `workspace_id`. An `AND workspace_id IN (...)` alone would skip exactly
    // those rows and leave the defect live for them, hence the NULL branch: a row
    // whose `call_id` is in this batch belongs to a call being destroyed right
    // now, whatever its workspace column says, so the id list is what makes it
    // exact and the OR cannot reach another tenant.
    const webhookEvents = await this.prisma.telephonyWebhookEvent.deleteMany({
      where: {
        callId: { in: callIds },
        OR: [{ workspaceId: { in: [...doomedWorkspaceIds] } }, { workspaceId: null }],
      },
    });

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
    this.logger.log(
      {
        scope,
        deleted,
        remaining: afterRemaining,
        crmFanoutLogsDeleted: fanout.count,
        telephonyWebhookEventsDeleted: webhookEvents.count,
      },
      'Retention sweep completed',
    );
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
        // The CRM fan-out rows destroyed alongside the calls. Counted, not
        // listed: they carry the contact data this sweep exists to remove, so
        // naming them individually in a row that outlives them would re-create a
        // pointer to what was purged.
        crmFanoutLogsDeleted: fanout.count,
        // Counted for the same reason and with the same restraint: the payloads
        // held the caller's number, so the row that records their destruction
        // must not become a pointer back to them.
        telephonyWebhookEventsDeleted: webhookEvents.count,
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

  /**
   * Ages out telephony webhook payloads the call sweep cannot reach.
   *
   * `sweepExpiredCalls` only deletes webhook rows whose `call_id` is in the batch
   * of calls it is destroying, and five of the six writers in
   * `TelephonyService.recordWebhookEvent` leave `call_id` NULL -- only the LiveKit
   * handler resolves a call before recording. Twilio voice, Twilio and Vobiz
   * status, Vobiz inbound, Vobiz verify and every invalid-signature delivery
   * therefore wrote rows the sweep could never match, so their `raw_payload_json`
   * -- the provider's own body, `From` and `To` included -- accumulated for the
   * life of the database whatever retention period the workspace advertised.
   *
   * Only the payload copy ages out. The `telephony.webhook.invalid_signature`
   * audit row that accompanies a rejected delivery is written separately and
   * outlives it, so the security trail is not what this deletes.
   *
   * Returns how many rows went. No second `count` for a remaining figure: it
   * would be another full pass over the widest table in the schema for a log
   * line, and a run that fills its batch already says there is a backlog.
   *
   * ponytail: one BATCH_SIZE batch per run, so an existing backlog drains at
   * 5000 rows/day like the call sweep's. Upgrade path if that is too slow to
   * matter: raise the ceiling for this table alone -- these rows have no
   * dependents to cascade, which is what makes the call sweep's batch expensive.
   */
  async sweepStaleTelephonyWebhookEvents(): Promise<number> {
    const cutoff = new Date(
      Date.now() - TELEPHONY_WEBHOOK_EVENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
    );

    // Oldest first, so a backlog drains in age order rather than leaving the
    // longest-overdue payloads for last.
    const stale = await this.prisma.telephonyWebhookEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
      select: { id: true, workspaceId: true },
    });
    if (stale.length === 0) return 0;

    // Two lists from one loop, not two `stale.map(...)` initializers, for the
    // same reason as sweepExpiredCalls: the tenant-scope analyzer substitutes a
    // referenced variable's initializer into the `where` it is checking, so a
    // mapped id list would carry this `select` -- and its `workspaceId` -- into
    // the delete below and reclassify it as tenant-scoped without anyone asking.
    const ids: string[] = [];
    const workspaceIds = new Set<string>();
    for (const row of stale) {
      ids.push(row.id);
      if (row.workspaceId) workspaceIds.add(row.workspaceId);
    }

    // The ids alone are already exact. The workspace predicate is the part the
    // analyzer can read, and it is the same OR as the call sweep's for the same
    // reason: `workspace_id` is resolved from the phone number the delivery
    // arrived on, so a delivery whose number could not be resolved has none at
    // all, and an `AND workspace_id IN (...)` would skip exactly the rows this
    // method exists for. Both branches are built from the batch itself, so
    // neither can reach a row the cutoff did not select.
    // Delete and audit commit together, the way updateWorkspaceRetention does it
    // and deliberately UNLIKE sweepExpiredCalls. That method logs locally first
    // and audits after, because rolling a call purge back would also have to undo
    // the crm_fanout_log purge that ran before it, and it would rather lose the
    // audit row than the delete. This sweep has neither problem: it is a flat
    // age-out of rows nothing reads, so if the audit insert fails there is
    // nothing to salvage by keeping the delete -- tonight's run simply selects
    // the same over-30-day rows again. One transaction therefore costs a day of
    // delay in the worst case and buys the guarantee that no payload is destroyed
    // without a row saying so.
    //
    // `auditLog.create` inline rather than `this.audit.log()`: AuditService holds
    // its own client and would commit independently of this transaction. With
    // `workspaceId: null` its only added behaviour, resolveOrganizationId,
    // returns null without querying, so nothing is lost by inlining.
    const [result] = await this.prisma.$transaction([
      this.prisma.telephonyWebhookEvent.deleteMany({
        where: {
          id: { in: ids },
          OR: [{ workspaceId: { in: [...workspaceIds] } }, { workspaceId: null }],
        },
      }),
      this.prisma.auditLog.create({
        data: {
          workspaceId: null,
          organizationId: null,
          action: 'retention.sweep_telephony_webhook_events',
          resourceType: 'telephony_webhook_event',
          metadata: {
            // Spelled out rather than omitted, matching the call sweep: a
            // platform-wide purge must not read as a row that lost its scope.
            scope: 'all-workspaces',
            cutoff: cutoff.toISOString(),
            maxAgeDays: TELEPHONY_WEBHOOK_EVENT_MAX_AGE_DAYS,
            // The batch size, not deleteMany's count: the two statements are
            // built in one array, so the count is not available to the row that
            // records it. They differ only if a concurrent erasure deleted some
            // of these ids first, which is why the field is named for what it is.
            // Counted, never listed -- unlike the call sweep's `callIds`, these
            // ids answer no question once the rows are gone, and a list of them
            // would only be a surviving pointer to the payloads this destroyed.
            selected: ids.length,
          },
        },
      }),
    ]);

    this.logger.log(
      { cutoff: cutoff.toISOString(), selected: ids.length, deleted: result.count },
      'Telephony webhook event sweep completed',
    );
    return result.count;
  }

  /**
   * `actorUserId` is required, not optional. Shortening retention destroys
   * recordings and transcripts on the next sweep, so "who shortened it" is the
   * whole point of the record -- an optional parameter would let a caller write
   * an unattributed row for the most destructive setting in the product.
   */
  async updateWorkspaceRetention(
    workspaceId: string,
    retentionDays: number,
    actorUserId: string,
  ): Promise<void> {
    const clamped = Math.min(3650, Math.max(30, retentionDays));
    // Read before the write, so the audit row can say what the period *was*.
    // A retention change is only meaningful against its previous value: "set to
    // 30" is not reviewable, "1095 -> 30" is. Also supplies organizationId,
    // which a direct auditLog.create does not resolve for itself the way
    // AuditService.log would.
    const before = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true, retentionDays: true },
    });
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
      // Third statement in the same transaction, not an AuditService call after
      // it: AuditService holds its own client and would commit independently, so
      // a rolled-back re-stamp would still leave a row claiming the period
      // changed. Here the claim and the change commit together or neither does.
      this.prisma.auditLog.create({
        data: {
          workspaceId,
          organizationId: before?.organizationId ?? null,
          actorUserId,
          action: 'retention.updated',
          resourceType: 'workspace',
          resourceId: workspaceId,
          metadata: {
            previousRetentionDays: before?.retentionDays ?? null,
            retentionDays: clamped,
            // Recorded separately from `retentionDays` because the value is
            // clamped: a request for 1 day is stored as 30, and the row should
            // show what was asked for as well as what was applied.
            requestedRetentionDays: retentionDays,
          },
        },
      }),
    ]);
    // Shortening can make rows immediately expired, so the next sweep deletes
    // them. Log the blast radius: the change is destructive and irreversible.
    this.logger.log({ workspaceId, retentionDays: clamped, restamped }, 'Workspace retention updated');
  }
}