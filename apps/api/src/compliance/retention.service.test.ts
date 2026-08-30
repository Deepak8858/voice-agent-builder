import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditPayload } from '../audit/audit.service';
import { RetentionService } from './retention.service';

interface FakeCall {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
  workspaceId: string;
  retentionDays?: number;
}

/**
 * A crm_fanout_log row. `contactData` is the reason this table matters to a
 * retention sweep: it holds the contact's name, phone and email as they were
 * handed to the CRM, and `call_id` is ON DELETE SET NULL, so deleting the call
 * leaves the row behind with nothing left to find it by.
 */
interface FakeFanout {
  id: string;
  callId: string | null;
  workspaceId: string | null;
  contactData: { phone: string };
}

interface FakeWhere {
  expiresAt?: { lt: Date };
  workspaceId?: string;
  id?: { in: string[] };
}

interface FakeFanoutWhere {
  callId?: { in: string[] };
  workspaceId?: { in: string[] };
}

/**
 * Same "honour only the clauses that are present" rule as `matching`: dropping
 * either predicate from the service shows up as fan-out rows destroyed for calls
 * that were never swept.
 */
function matchingFanout(rows: FakeFanout[], where: FakeFanoutWhere): FakeFanout[] {
  return rows.filter(r =>
    (where.callId === undefined || (r.callId !== null && where.callId.in.includes(r.callId)))
    && (where.workspaceId === undefined
      || (r.workspaceId !== null && where.workspaceId.in.includes(r.workspaceId))));
}

/**
 * Applies the predicate the service actually bound. Every clause is honoured
 * only when present, so dropping one from the service shows up as rows matched
 * (and, for deleteMany, rows destroyed) in another workspace.
 */
function matching(calls: FakeCall[], where: FakeWhere): FakeCall[] {
  return calls.filter(c =>
    (where.expiresAt === undefined || (c.expiresAt !== null && c.expiresAt < where.expiresAt.lt))
    && (where.workspaceId === undefined || c.workspaceId === where.workspaceId)
    && (where.id === undefined || where.id.in.includes(c.id)));
}

interface FakeState {
  calls: FakeCall[];
  /** crm_fanout_log rows, which the sweep must remove before the calls go. */
  fanoutLogs?: FakeFanout[];
  /** Last raw statement the service issued, so tests can pin its shape. */
  raw?: { sql: string; values: unknown[] };
  /** Last workspace row written. */
  workspace?: { id: string; retentionDays: number };
  /**
   * The stored workspace as it stands *before* an update, so the audit row's
   * previousRetentionDays can be pinned to a real prior value rather than null.
   */
  workspaceRow?: { organizationId: string | null; retentionDays: number };
  /**
   * Audit writes in order, each with the call ids still present at the moment
   * the write happened -- so ordering (delete first, audit second) is asserted
   * without a second spy.
   */
  audits?: { payload: AuditPayload; callIdsStillPresent: string[] }[];
  /** Runs once the batch has been selected, to simulate a concurrent writer. */
  afterBatchSelected?: () => void;
}

function makeService(state: FakeState) {
  const prisma = {
    call: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.calls.find(c => c.id === where.id) ?? null),
      count: vi.fn(async ({ where }: { where: FakeWhere }) => matching(state.calls, where).length),
      // orderBy is honoured so the batch really is longest-expired-first: with
      // insertion order instead, the audit row's id list would be untestable.
      findMany: vi.fn(async ({ where, take, orderBy }: { where: FakeWhere, take: number, orderBy: { expiresAt?: 'asc' | 'desc' }, select: unknown }) => {
        const batch = matching(state.calls, where)
          .sort((a, b) => (orderBy.expiresAt === 'asc' ? a.expiresAt!.getTime() - b.expiresAt!.getTime() : 0))
          .slice(0, take)
          .map(c => ({ id: c.id, workspaceId: c.workspaceId }));
        state.afterBatchSelected?.();
        return batch;
      }),
      deleteMany: vi.fn(async ({ where }: { where: FakeWhere }) => {
        const doomed = matching(state.calls, where);
        state.calls = state.calls.filter(c => !doomed.includes(c));
        return { count: doomed.length };
      }),
    },
    crmFanoutLog: {
      deleteMany: vi.fn(async ({ where }: { where: FakeFanoutWhere }) => {
        const rows = state.fanoutLogs ?? [];
        const doomed = matchingFanout(rows, where);
        state.fanoutLogs = rows.filter(r => !doomed.includes(r));
        return { count: doomed.length };
      }),
    },
    workspace: {
      findUnique: vi.fn(async () => state.workspaceRow ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { retentionDays: number } }) => {
        state.workspace = { id: where.id, retentionDays: data.retentionDays };
        return {};
      }),
    },
    // Recorded into the same list as AuditService.log writes, so a test asserting
    // "one audit row" cannot be satisfied by writing through both paths.
    auditLog: {
      create: vi.fn(async ({ data }: { data: AuditPayload }) => {
        (state.audits ??= []).push({ payload: data, callIdsStillPresent: state.calls.map(c => c.id) });
        return {};
      }),
    },
    // Stands in for the parameterised UPDATE: applies the WHERE the service
    // bound (workspace id) so cross-tenant leakage would show up as mutated
    // rows in another workspace.
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.raw.join('?');
      state.raw = { sql, values };
      const days = values[0] as number;
      // Honour the tenant predicate only if the statement actually has one, so
      // dropping the WHERE shows up as rows mutated in the other workspace.
      const scoped = /where\s+workspace_id\s*=/i.test(sql);
      const workspaceId = values[values.length - 1] as string;
      let count = 0;
      for (const call of state.calls) {
        if (scoped && call.workspaceId !== workspaceId) continue;
        call.expiresAt = new Date(call.createdAt.getTime() + days * 24 * 60 * 60 * 1000);
        call.retentionDays = days;
        count += 1;
      }
      return count;
    }),
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  } as unknown as { call: Record<string, unknown>; workspace: Record<string, unknown> };
  const audit = {
    log: vi.fn(async (payload: AuditPayload) => {
      (state.audits ??= []).push({ payload, callIdsStillPresent: state.calls.map(c => c.id) });
    }),
  };
  return new RetentionService(prisma as never, audit as never);
}

describe('RetentionService', () => {
  let service: RetentionService;

  beforeEach(() => {
    service = makeService({ calls: [] });
  });

  describe('computeExpiresAt', () => {
    it('should be defined', () => expect(service).toBeDefined());

    it('should compute expires_at from created_at + retention_days', () => {
      const now = new Date();
      const expires = service.computeExpiresAt(now, 365);
      const expected = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
      expect(expires.getTime()).toBeCloseTo(expected.getTime(), -3);
    });
  });

  describe('sweepExpiredCalls', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const old = new Date('2025-01-01T00:00:00.000Z');

    /** Two expired calls in ws-a, one expired in ws-b, one unexpired in ws-a. */
    function twoWorkspaces(): FakeState {
      return {
        calls: [
          { id: 'call-a1', workspaceId: 'ws-a', createdAt: old, expiresAt: new Date(now.getTime() - 2000) },
          { id: 'call-a2', workspaceId: 'ws-a', createdAt: old, expiresAt: new Date(now.getTime() - 1000) },
          { id: 'call-b1', workspaceId: 'ws-b', createdAt: old, expiresAt: new Date(now.getTime() - 3000) },
          { id: 'call-a3', workspaceId: 'ws-a', createdAt: old, expiresAt: new Date(now.getTime() + 86_400_000) },
        ],
      };
    }

    // The audit row records the cutoff instant, so `now` has to be pinned.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
    });
    afterEach(() => vi.useRealTimers());

    it('deletes every expired call when given no scope', async () => {
      const state = twoWorkspaces();
      const result = await makeService(state).sweepExpiredCalls();

      expect(result).toEqual({ deleted: 3, remaining: 0 });
      // Longest-expired first, and the unexpired call survives.
      expect(state.calls.map(c => c.id)).toEqual(['call-a3']);
    });

    it('purges only the named workspace when scoped', async () => {
      const state = twoWorkspaces();
      const result = await makeService(state).sweepExpiredCalls({ workspaceId: 'ws-a' });

      expect(result).toEqual({ deleted: 2, remaining: 0 });
      // Row-level: another tenant's expired call must still be there.
      expect(state.calls.map(c => c.id).sort()).toEqual(['call-a3', 'call-b1']);
    });

    it('writes one audit row per run naming the count, scope, cutoff and ids', async () => {
      const state = twoWorkspaces();
      await makeService(state).sweepExpiredCalls({ workspaceId: 'ws-a' });

      expect(state.audits).toHaveLength(1);
      const { payload } = state.audits![0]!;
      expect(payload.workspaceId).toBe('ws-a');
      expect(payload.action).toBe('retention.sweep');
      expect(payload.resourceType).toBe('call');
      expect(payload.metadata).toEqual({
        scope: 'ws-a',
        cutoff: now.toISOString(),
        deleted: 2,
        remaining: 0,
        crmFanoutLogsDeleted: 0,
        // Longest-expired first, matching the delete order.
        callIds: ['call-a1', 'call-a2'],
      });
    });

    it('names a cross-tenant run explicitly rather than leaving the scope blank', async () => {
      const state = twoWorkspaces();
      await makeService(state).sweepExpiredCalls();

      const { payload } = state.audits![0]!;
      expect(payload.workspaceId).toBeNull();
      expect(payload.metadata!['scope']).toBe('all-workspaces');
      expect(payload.metadata!['callIds']).toEqual(['call-b1', 'call-a1', 'call-a2']);
    });

    it('audits only after the rows are gone, so the row cannot claim a delete that did not happen', async () => {
      const state = twoWorkspaces();
      await makeService(state).sweepExpiredCalls();

      expect(state.audits![0]!.callIdsStillPresent).toEqual(['call-a3']);
    });

    it('does not delete a call whose retention was lengthened after the batch was picked', async () => {
      const state = twoWorkspaces();
      state.afterBatchSelected = () => {
        // updateWorkspaceRetention re-stamping call-a1 to a longer period.
        state.calls.find(c => c.id === 'call-a1')!.expiresAt = new Date(now.getTime() + 86_400_000);
        state.afterBatchSelected = undefined;
      };
      const result = await makeService(state).sweepExpiredCalls();

      expect(result.deleted).toBe(2);
      expect(state.calls.map(c => c.id).sort()).toEqual(['call-a1', 'call-a3']);
    });

    it('writes no audit row when nothing has expired', async () => {
      const state: FakeState = {
        calls: [{ id: 'call-a3', workspaceId: 'ws-a', createdAt: old, expiresAt: new Date(now.getTime() + 1000) }],
      };
      const result = await makeService(state).sweepExpiredCalls();

      expect(result).toEqual({ deleted: 0, remaining: 0 });
      expect(state.audits).toBeUndefined();
    });

    /**
     * `crm_fanout_log.call_id` is ON DELETE SET NULL and `contact_data` holds the
     * contact's name, phone and email as they were handed to the CRM. Without
     * this delete the sweep purges the recording and transcript and leaves the
     * contact's personal data behind forever, with no call id left to find it by.
     */
    it('destroys the CRM fan-out rows of the calls it purges, before the calls', async () => {
      const state = twoWorkspaces();
      state.fanoutLogs = [
        { id: 'f-a1', callId: 'call-a1', workspaceId: 'ws-a', contactData: { phone: '+14155550111' } },
        { id: 'f-a2', callId: 'call-a2', workspaceId: 'ws-a', contactData: { phone: '+14155550222' } },
        { id: 'f-a3', callId: 'call-a3', workspaceId: 'ws-a', contactData: { phone: '+14155550333' } },
      ];
      const service = makeService(state);
      const prisma = (service as unknown as {
        prisma: { call: { deleteMany: ReturnType<typeof vi.fn> }; crmFanoutLog: { deleteMany: ReturnType<typeof vi.fn> } };
      }).prisma;

      const result = await service.sweepExpiredCalls({ workspaceId: 'ws-a' });

      expect(result.deleted).toBe(2);
      // Only the unexpired call's row survives.
      expect(state.fanoutLogs.map(r => r.id)).toEqual(['f-a3']);
      // Before the calls: afterwards `call_id` is already NULL and the rows are
      // unreachable by id, which is the whole defect.
      expect(prisma.crmFanoutLog.deleteMany.mock.invocationCallOrder[0])
        .toBeLessThan(prisma.call.deleteMany.mock.invocationCallOrder[0]);
    });

    it('leaves another workspace fan-out rows alone, and counts what it destroyed', async () => {
      const state = twoWorkspaces();
      state.fanoutLogs = [
        { id: 'f-a1', callId: 'call-a1', workspaceId: 'ws-a', contactData: { phone: '+14155550111' } },
        // Expired too, but in another tenant: a scoped run must not touch it.
        { id: 'f-b1', callId: 'call-b1', workspaceId: 'ws-b', contactData: { phone: '+14155550999' } },
      ];
      await makeService(state).sweepExpiredCalls({ workspaceId: 'ws-a' });

      expect(state.fanoutLogs.map(r => r.id)).toEqual(['f-b1']);
      expect(state.audits![0]!.payload.metadata!['crmFanoutLogsDeleted']).toBe(1);
      // Counted, never listed: the ids would be a surviving pointer to the
      // contact data the sweep just destroyed.
      expect(JSON.stringify(state.audits![0]!.payload.metadata)).not.toContain('f-a1');
    });

    // Known, deliberately unfixed gap: `expires_at IS NULL` is never < now, so
    // an unstamped call is never purged. Pinned so the behaviour is visible
    // rather than surprising, and so a future fix has to change this test on
    // purpose. See the report: a bare `expiresAt: null` predicate would delete
    // calls recorded today.
    it('never purges a call with no expires_at', async () => {
      const state: FakeState = {
        calls: [{ id: 'call-unstamped', workspaceId: 'ws-a', createdAt: old, expiresAt: null }],
      };
      const result = await makeService(state).sweepExpiredCalls();

      expect(result).toEqual({ deleted: 0, remaining: 0 });
      expect(state.calls.map(c => c.id)).toEqual(['call-unstamped']);
    });
  });

  describe('updateWorkspaceRetention', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const createdAt = new Date('2026-01-01T00:00:00.000Z');

    function stateWithTwoWorkspaces(): FakeState {
      return {
        calls: [
          { id: 'call-a1', workspaceId: 'ws-a', createdAt, expiresAt: new Date(createdAt.getTime() + 365 * DAY), retentionDays: 365 },
          { id: 'call-a2', workspaceId: 'ws-a', createdAt, expiresAt: new Date(createdAt.getTime() + 365 * DAY), retentionDays: 365 },
          { id: 'call-b1', workspaceId: 'ws-b', createdAt, expiresAt: new Date(createdAt.getTime() + 365 * DAY), retentionDays: 365 },
        ],
      };
    }

    it('re-stamps existing calls when the period is shortened', async () => {
      const state = stateWithTwoWorkspaces();
      await makeService(state).updateWorkspaceRetention('ws-a', 30, 'user-1');

      expect(state.workspace).toEqual({ id: 'ws-a', retentionDays: 30 });
      for (const id of ['call-a1', 'call-a2']) {
        const call = state.calls.find(c => c.id === id)!;
        expect(call.retentionDays).toBe(30);
        expect(call.expiresAt).toEqual(new Date(createdAt.getTime() + 30 * DAY));
      }
    });

    it('stamps the clamped period, not the requested one', async () => {
      const tooShort = stateWithTwoWorkspaces();
      await makeService(tooShort).updateWorkspaceRetention('ws-a', 1, 'user-1');
      expect(tooShort.calls.find(c => c.id === 'call-a1')!.retentionDays).toBe(30);
      expect(tooShort.calls.find(c => c.id === 'call-a1')!.expiresAt).toEqual(new Date(createdAt.getTime() + 30 * DAY));

      const tooLong = stateWithTwoWorkspaces();
      await makeService(tooLong).updateWorkspaceRetention('ws-a', 99999, 'user-1');
      expect(tooLong.calls.find(c => c.id === 'call-a1')!.retentionDays).toBe(3650);
      expect(tooLong.calls.find(c => c.id === 'call-a1')!.expiresAt).toEqual(new Date(createdAt.getTime() + 3650 * DAY));
    });

    it('leaves calls in another workspace untouched', async () => {
      const state = stateWithTwoWorkspaces();
      await makeService(state).updateWorkspaceRetention('ws-a', 30, 'user-1');

      const other = state.calls.find(c => c.id === 'call-b1')!;
      expect(other.retentionDays).toBe(365);
      expect(other.expiresAt).toEqual(new Date(createdAt.getTime() + 365 * DAY));

      // The analyzer cannot read raw SQL, so pin the tenant predicate and the
      // fact that both the day count and the workspace id are bound parameters.
      expect(state.raw!.sql).toContain('WHERE workspace_id = ?::uuid');
      expect(state.raw!.values).toEqual([30, 30, 'ws-a']);
    });

    it('re-stamps existing calls when the period is lengthened', async () => {
      const state = stateWithTwoWorkspaces();
      await makeService(state).updateWorkspaceRetention('ws-a', 730, 'user-1');

      const call = state.calls.find(c => c.id === 'call-a1')!;
      expect(call.retentionDays).toBe(730);
      expect(call.expiresAt).toEqual(new Date(createdAt.getTime() + 730 * DAY));
    });

    it('audits who shortened retention, from what, and what they asked for', async () => {
      const state = stateWithTwoWorkspaces();
      state.workspaceRow = { organizationId: 'org-1', retentionDays: 1095 };
      // 1 is below the floor, so the requested and applied values differ and the
      // row has to carry both.
      await makeService(state).updateWorkspaceRetention('ws-a', 1, 'user-1');

      expect(state.audits).toHaveLength(1);
      expect(state.audits![0]!.payload).toEqual({
        workspaceId: 'ws-a',
        organizationId: 'org-1',
        actorUserId: 'user-1',
        action: 'retention.updated',
        resourceType: 'workspace',
        resourceId: 'ws-a',
        metadata: {
          previousRetentionDays: 1095,
          retentionDays: 30,
          requestedRetentionDays: 1,
        },
      });
    });

    it('writes the audit row in the same transaction as the change', async () => {
      const state = stateWithTwoWorkspaces();
      state.workspaceRow = { organizationId: 'org-1', retentionDays: 365 };
      const service = makeService(state);
      // Pin that the row is a transaction participant, not a follow-up write: if
      // the create moves outside $transaction, it still runs and the assertion
      // above still passes, so ordering alone cannot catch the regression.
      const tx = (service as unknown as { prisma: { $transaction: ReturnType<typeof vi.fn> } }).prisma.$transaction;
      await service.updateWorkspaceRetention('ws-a', 30, 'user-1');

      expect(tx).toHaveBeenCalledTimes(1);
      expect(tx.mock.calls[0]![0]).toHaveLength(3);
      expect(state.audits).toHaveLength(1);
    });
  });

  /**
   * `sweepExpiredCalls` issues one bulk DELETE on `calls`. Everything the
   * database cascades from it is destroyed with no code path able to object, so
   * the disposition of each foreign key pointing at `calls` is a property of the
   * schema, not of any function -- and it is pinned here, against the schema
   * file, because nothing else in this suite can see it.
   */
  describe('what a purged call takes with it', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const schema = fs.readFileSync(path.join(repoRoot, 'apps/api/prisma/schema.prisma'), 'utf8');

    function modelBody(name: string): string {
      const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
      expect(match, `model ${name} is missing from schema.prisma`).not.toBeNull();
      return match![1]!;
    }

    // The money rows. Cascading these away meant the sweep destroyed the only
    // evidence that a customer had been charged for the call at all, which is
    // what forbade ever scheduling it.
    it.each(['CallUsage', 'RuntimeUsageEvent'])(
      '%s survives its call, keeping the charge and nulling the pointer',
      (name) => {
        const body = modelBody(name);
        expect(body).toMatch(/callId\s+String\?\s/);
        expect(body).toMatch(/call\s+Call\?\s+@relation\([^)]*onDelete: SetNull/);
      },
    );

    // The content rows. Destroying these IS the sweep, so the fix above must not
    // be copied onto them: SET NULL here would leave the transcript and the
    // recording pointer in place, detached from any tenant.
    it.each(['CallEvent', 'CallEvaluation'])('%s is still cascaded away', (name) => {
      expect(modelBody(name)).toMatch(/call\s+Call\s+@relation\([^)]*onDelete: Cascade/);
    });

    // The Prisma schema does not change the database. Without the migration the
    // production foreign key stays ON DELETE CASCADE and the P0 is still live.
    it('ships the migration that relaxes both foreign keys in Postgres', () => {
      const sql = fs.readFileSync(
        path.join(
          repoRoot,
          'apps/api/prisma/migrations/20260830100000_billing_survives_call_deletion/migration.sql',
        ),
        'utf8',
      );
      for (const table of ['call_usages', 'runtime_usage_events']) {
        expect(sql).toContain(`ALTER TABLE "${table}" ALTER COLUMN "call_id" DROP NOT NULL;`);
        expect(sql).toMatch(
          new RegExp(`ADD CONSTRAINT "${table}_call_id_fkey"[\\s\\S]*?ON DELETE SET NULL`),
        );
      }
    });
  });
});