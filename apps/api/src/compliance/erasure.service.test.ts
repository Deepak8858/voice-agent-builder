import { describe, expect, it, vi } from 'vitest';
import { ErasureService } from './erasure.service';

// Every workspace-scoped model the erasure path must clear. Mirrors the
// non-CASCADE foreign keys pointing at `workspaces`.
const WORKSPACE_SCOPED_MODELS = [
  'toolInvocation',
  'analyticsEvent',
  'callEvaluation',
  'callEvent',
  'complianceCheck',
  'knowledgeChunk',
  'knowledgeSource',
  'call',
  'consentRecord',
  'contact',
  'dncEntry',
  'integrationTool',
  'agent',
  'membership',
] as const;

interface KnowledgeRow {
  fileUrl: string | null;
  metadata: unknown;
}

describe('ErasureService', () => {
  function makeService(opts: {
    contact?: { id: string; phone: string } | null;
    calls?: Array<{ id: string }>;
    organization?: { id: string; name: string } | null;
    workspaces?: Array<{ id: string }>;
    knowledgeSources?: KnowledgeRow[];
    deleteStoredFileImpl?: (file: unknown) => Promise<void>;
  }) {
    const deletedContacts: string[] = [];
    const deletedWorkspaces: string[] = [];
    const deletedOrganizations: string[] = [];
    const auditLogs: Array<Record<string, unknown>> = [];
    // Records the order in which models were cleared so we can assert that
    // child rows are removed before the parents they reference.
    const deleteOrder: string[] = [];

    const prisma: Record<string, unknown> = {
      contact: {
        findFirst: vi.fn(async () => opts.contact ?? null),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deletedContacts.push(where.id);
          return { id: where.id };
        }),
        deleteMany: vi.fn(async () => {
          deleteOrder.push('contact');
          return { count: 0 };
        }),
      },
      call: {
        findMany: vi.fn(async () => opts.calls ?? []),
        deleteMany: vi.fn(async () => {
          deleteOrder.push('call');
          return { count: 0 };
        }),
      },
      organization: {
        findUnique: vi.fn(async () => opts.organization ?? null),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deletedOrganizations.push(where.id);
          return { id: where.id };
        }),
      },
      workspace: {
        findMany: vi.fn(async () => opts.workspaces ?? []),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deleteOrder.push(`workspace:${where.id}`);
          deletedWorkspaces.push(where.id);
          return { id: where.id };
        }),
      },
      knowledgeSource: {
        findMany: vi.fn(async () => opts.knowledgeSources ?? []),
        deleteMany: vi.fn(async () => {
          deleteOrder.push('knowledgeSource');
          return { count: 0 };
        }),
      },
      user: { findUnique: vi.fn(async () => null) },
      membership: {
        deleteMany: vi.fn(async () => {
          deleteOrder.push('membership');
          return { count: 0 };
        }),
      },
      workspaceMembership: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };

    for (const model of WORKSPACE_SCOPED_MODELS) {
      if (!prisma[model]) {
        prisma[model] = {
          deleteMany: vi.fn(async () => {
            deleteOrder.push(model);
            return { count: 0 };
          }),
        };
      }
    }

    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(prisma);
    });

    const audit = {
      log: vi.fn(async (data: Record<string, unknown>) => {
        auditLogs.push(data);
      }),
    };

    const deletedFiles: unknown[] = [];
    const fileStorage = {
      saveUploadedFile: vi.fn(),
      deleteStoredFile: vi.fn(async (file: unknown) => {
        if (opts.deleteStoredFileImpl) return opts.deleteStoredFileImpl(file);
        deletedFiles.push(file);
      }),
    };

    return {
      service: new ErasureService(prisma as never, audit as never, fileStorage as never),
      prisma,
      audit,
      fileStorage,
      deletedContacts,
      deletedWorkspaces,
      deletedOrganizations,
      deletedFiles,
      deleteOrder,
      auditLogs,
    };
  }

  function s3Source(path: string): KnowledgeRow {
    return {
      fileUrl: `s3://voiceforge-knowledge/${path}`,
      metadata: {
        storage_provider: 's3',
        storage_bucket: 'voiceforge-knowledge',
        storage_path: path,
      },
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

  describe('eraseOrganization', () => {
    it('returns an error for a non-existent organization', async () => {
      const { service } = makeService({ organization: null });
      const result = await service.eraseOrganization('org-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Organization not found');
    });

    it('clears every workspace-scoped table before deleting the workspace', async () => {
      const { service, prisma, deleteOrder, deletedOrganizations } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      // Every non-cascade child table must be cleared, otherwise Postgres
      // aborts the delete with a foreign key violation.
      for (const model of WORKSPACE_SCOPED_MODELS) {
        const client = prisma[model] as { deleteMany: ReturnType<typeof vi.fn> };
        expect(client.deleteMany, `${model}.deleteMany was not called`).toHaveBeenCalledWith({
          where: { workspaceId: 'ws-1' },
        });
      }
      // Memberships are the constraint that previously aborted erasure outright.
      expect(deleteOrder.indexOf('membership')).toBeLessThan(deleteOrder.indexOf('workspace:ws-1'));
      // Chunks reference sources; sources reference agents.
      expect(deleteOrder.indexOf('knowledgeChunk')).toBeLessThan(deleteOrder.indexOf('knowledgeSource'));
      expect(deleteOrder.indexOf('knowledgeSource')).toBeLessThan(deleteOrder.indexOf('agent'));
      expect(deleteOrder.indexOf('call')).toBeLessThan(deleteOrder.indexOf('agent'));
      expect(deletedOrganizations).toEqual(['org-1']);
    });

    it('deletes stored knowledge files for every workspace in the organization', async () => {
      const { service, fileStorage, deletedFiles } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }],
        knowledgeSources: [s3Source('knowledge/a.pdf'), s3Source('knowledge/b.pdf')],
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(fileStorage.deleteStoredFile).toHaveBeenCalledTimes(2);
      expect(deletedFiles).toEqual([
        expect.objectContaining({ provider: 's3', bucket: 'voiceforge-knowledge', path: 'knowledge/a.pdf' }),
        expect.objectContaining({ provider: 's3', bucket: 'voiceforge-knowledge', path: 'knowledge/b.pdf' }),
      ]);
    });

    it('routes deletion by the stored provider, not the current config', async () => {
      const { service, deletedFiles } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [
          {
            fileUrl: 'https://project.supabase.co/storage/v1/object/kb/legacy.pdf',
            metadata: {
              storage_provider: 'supabase',
              storage_bucket: 'kb',
              storage_path: 'legacy.pdf',
            },
          },
          s3Source('knowledge/new.pdf'),
        ],
      });

      await service.eraseOrganization('org-1');

      expect(deletedFiles).toEqual([
        expect.objectContaining({ provider: 'supabase', bucket: 'kb' }),
        expect.objectContaining({ provider: 's3', bucket: 'voiceforge-knowledge' }),
      ]);
    });

    it('collects storage coordinates before the rows are deleted', async () => {
      const { service, prisma } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [s3Source('knowledge/a.pdf')],
      });

      await service.eraseOrganization('org-1');

      // The metadata lives on the rows themselves, so it must be read before
      // the transaction removes them.
      const findMany = (prisma.knowledgeSource as { findMany: ReturnType<typeof vi.fn> }).findMany;
      const deleteMany = (prisma.knowledgeSource as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany;
      expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]);
    });

    it('ignores rows whose metadata has no usable storage coordinates', async () => {
      const { service, fileStorage } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [
          { fileUrl: null, metadata: null },
          { fileUrl: 'https://example.com/x.pdf', metadata: { storage_provider: 'unknown' } },
          { fileUrl: 'https://example.com/y.pdf', metadata: { storage_provider: 's3' } },
        ],
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(fileStorage.deleteStoredFile).not.toHaveBeenCalled();
    });

    it('still reports success when storage deletion fails', async () => {
      const { service } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [s3Source('knowledge/a.pdf')],
        deleteStoredFileImpl: async () => {
          throw new Error('AccessDenied');
        },
      });

      // The database rows are already gone; throwing here would report failure
      // for an erasure that actually happened.
      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(result.erasedAt).toBeDefined();
    });

    it('does not purge storage when the erasure transaction fails', async () => {
      const { service, prisma, fileStorage } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [s3Source('knowledge/a.pdf')],
      });
      prisma.$transaction = vi.fn(async () => {
        throw new Error('deadlock detected');
      });

      await expect(service.eraseOrganization('org-1')).rejects.toThrow('deadlock detected');
      // Customer files must survive a rolled-back erasure.
      expect(fileStorage.deleteStoredFile).not.toHaveBeenCalled();
    });
  });
});
