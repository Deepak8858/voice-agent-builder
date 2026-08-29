import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionService } from './retention.service';

interface FakeCall {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
  workspaceId?: string;
  retentionDays?: number;
}

interface FakeState {
  calls: FakeCall[];
  /** Last raw statement the service issued, so tests can pin its shape. */
  raw?: { sql: string; values: unknown[] };
  /** Last workspace row written. */
  workspace?: { id: string; retentionDays: number };
}

function makeService(state: FakeState) {
  const prisma = {
    call: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.calls.find(c => c.id === where.id) ?? null),
      count: vi.fn(async ({ where }: { where: { expiresAt?: { lt: Date } } }) =>
        state.calls.filter(c => c.expiresAt && where.expiresAt?.lt && c.expiresAt < where.expiresAt.lt).length),
      findMany: vi.fn(async ({ where, take }: { where: { expiresAt?: { lt: Date } }, take: number, orderBy: unknown, select: unknown }) =>
        state.calls.filter(c => c.expiresAt && where.expiresAt?.lt && c.expiresAt < where.expiresAt.lt).slice(0, take).map(c => ({ id: c.id }))),
      deleteMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => {
        const ids = where.id?.in ?? [];
        return { count: ids.length };
      }),
    },
    workspace: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { retentionDays: number } }) => {
        state.workspace = { id: where.id, retentionDays: data.retentionDays };
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
  return new RetentionService(prisma as never);
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
    it('should sweep expired calls in batches', async () => {
      const now = new Date();
      service = makeService({
        calls: [
          { id: 'call-1', createdAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000), expiresAt: new Date(now.getTime() - 1000) },
          { id: 'call-2', createdAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000), expiresAt: new Date(now.getTime() - 2000) },
        ],
      });
      const result = await service.sweepExpiredCalls();
      expect(typeof result.deleted).toBe('number');
      expect(typeof result.remaining).toBe('number');
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
      await makeService(state).updateWorkspaceRetention('ws-a', 30);

      expect(state.workspace).toEqual({ id: 'ws-a', retentionDays: 30 });
      for (const id of ['call-a1', 'call-a2']) {
        const call = state.calls.find(c => c.id === id)!;
        expect(call.retentionDays).toBe(30);
        expect(call.expiresAt).toEqual(new Date(createdAt.getTime() + 30 * DAY));
      }
    });

    it('stamps the clamped period, not the requested one', async () => {
      const tooShort = stateWithTwoWorkspaces();
      await makeService(tooShort).updateWorkspaceRetention('ws-a', 1);
      expect(tooShort.calls.find(c => c.id === 'call-a1')!.retentionDays).toBe(30);
      expect(tooShort.calls.find(c => c.id === 'call-a1')!.expiresAt).toEqual(new Date(createdAt.getTime() + 30 * DAY));

      const tooLong = stateWithTwoWorkspaces();
      await makeService(tooLong).updateWorkspaceRetention('ws-a', 99999);
      expect(tooLong.calls.find(c => c.id === 'call-a1')!.retentionDays).toBe(3650);
      expect(tooLong.calls.find(c => c.id === 'call-a1')!.expiresAt).toEqual(new Date(createdAt.getTime() + 3650 * DAY));
    });

    it('leaves calls in another workspace untouched', async () => {
      const state = stateWithTwoWorkspaces();
      await makeService(state).updateWorkspaceRetention('ws-a', 30);

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
      await makeService(state).updateWorkspaceRetention('ws-a', 730);

      const call = state.calls.find(c => c.id === 'call-a1')!;
      expect(call.retentionDays).toBe(730);
      expect(call.expiresAt).toEqual(new Date(createdAt.getTime() + 730 * DAY));
    });
  });
});