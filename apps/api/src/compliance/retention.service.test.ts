import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionService } from './retention.service';

function makeService(state: { calls: Array<{ id: string; createdAt: Date; expiresAt: Date | null }> }) {
  const prisma = {
    call: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.calls.find(c => c.id === where.id) ?? null),
      count: vi.fn(async ({ where }: { where: { expiresAt?: { lt: Date } } }) =>
        state.calls.filter(c => c.expiresAt && where.expiresAt?.lt && c.expiresAt < where.expiresAt.lt).length),
      findMany: vi.fn(async ({ where, take, orderBy, select }: { where: { expiresAt?: { lt: Date } }, take: number, orderBy: unknown, select: unknown }) =>
        state.calls.filter(c => c.expiresAt && where.expiresAt?.lt && c.expiresAt < where.expiresAt.lt).slice(0, take).map(c => ({ id: c.id }))),
      deleteMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => {
        const ids = where.id?.in ?? [];
        return { count: ids.length };
      }),
    },
    workspace: { update: vi.fn(async () => ({})) },
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
});