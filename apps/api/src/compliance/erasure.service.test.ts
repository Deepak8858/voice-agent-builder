import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErasureService } from './erasure.service';

describe('ErasureService', () => {
  function makeService(opts: {
    contact?: { id: string; phone: string } | null;
    calls?: Array<{ id: string }>;
  }) {
    const deletedContacts: string[] = [];
    const deletedCalls: string[] = [];
    const auditLogs: Array<Record<string, unknown>> = [];

    const prisma = {
      contact: {
        findFirst: vi.fn(async () => opts.contact ?? null),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deletedContacts.push(where.id);
          return { id: where.id };
        }),
      },
      call: {
        findMany: vi.fn(async () => opts.calls ?? []),
      },
      analyticsEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      callEvaluation: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      toolInvocation: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
        await fn(prisma);
      }),
    };

    const audit = {
      log: vi.fn(async (data: Record<string, unknown>) => {
        auditLogs.push(data);
      }),
    };

    return {
      service: new ErasureService(prisma as any, audit as any),
      prisma,
      audit,
      deletedContacts,
      deletedCalls,
      auditLogs,
    };
  }

  it('should be defined', () => {
    const { service } = makeService({});
    expect(service).toBeDefined();
  });

  describe('eraseContact', () => {
    it('should return contact not found for non-existent contact', async () => {
      const { service } = makeService({ contact: null });
      const result = await service.eraseContact('ws-1', 'contact-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Contact not found');
    });
  });
});