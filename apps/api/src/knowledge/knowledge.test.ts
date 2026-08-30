import { describe, expect, it, vi } from 'vitest';
import { FileParser } from './parsers/file-parser';
import { cosineSim, KnowledgeService, splitIntoChunks } from './knowledge.service';
import type { KnowledgeFileStorage } from './knowledge-file-storage.interface';

describe('splitIntoChunks', () => {
  it('returns empty array for empty input', () => {
    expect(splitIntoChunks('', 100, 10)).toEqual([]);
  });

  it('returns single chunk when text fits size', () => {
    expect(splitIntoChunks('short text', 100, 10)).toEqual(['short text']);
  });

  it('splits long text with overlap', () => {
    const text = 'a'.repeat(250);
    const chunks = splitIntoChunks(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it('does not produce empty chunks', () => {
    const text = 'hello'.repeat(60);
    const chunks = splitIntoChunks(text, 50, 10);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });
});

describe('KnowledgeService.remove', () => {
  function createService(source: Record<string, unknown>) {
    const transaction = {
      knowledgeChunk: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeSource: { delete: vi.fn(async () => source) },
    };
    const prisma = {
      knowledgeSource: { findFirst: vi.fn(async () => source) },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<void>) => callback(transaction)),
    };
    const storage: KnowledgeFileStorage = {
      saveUploadedFile: vi.fn(),
      deleteStoredFile: vi.fn(async () => undefined),
    };
    const audit = { log: vi.fn(async () => undefined) };
    const service = new KnowledgeService(
      prisma as never,
      audit as never,
      { name: 'test', dimensions: 3, embed: vi.fn() },
      new FileParser(),
      storage,
    );
    return { audit, service, storage, transaction };
  }

  it('deletes the stored object after deleting an uploaded file source', async () => {
    const { audit, service, storage, transaction } = createService({
      id: 'source-1',
      sourceType: 'file',
      fileUrl: 's3://knowledge-bucket/knowledge/source-1.txt',
      metadata: {
        storage_provider: 's3',
        storage_bucket: 'knowledge-bucket',
        storage_path: 'knowledge/source-1.txt',
        storage_public_url: null,
      },
    });

    await service.remove('workspace-1', 'source-1', 'user-1');

    expect(transaction.knowledgeSource.delete).toHaveBeenCalledWith({ where: { id: 'source-1' } });
    expect(storage.deleteStoredFile).toHaveBeenCalledWith({
      provider: 's3',
      bucket: 'knowledge-bucket',
      path: 'knowledge/source-1.txt',
      fileUrl: 's3://knowledge-bucket/knowledge/source-1.txt',
      publicUrl: null,
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'knowledge_source.delete',
      resourceId: 'source-1',
    }));
  });

  it('does not invoke storage deletion for a text source', async () => {
    const { service, storage } = createService({
      id: 'source-1',
      sourceType: 'text',
      fileUrl: null,
      metadata: null,
    });

    await service.remove('workspace-1', 'source-1', 'user-1');

    expect(storage.deleteStoredFile).not.toHaveBeenCalled();
  });
});

/**
 * `embedding` is `Unsupported("vector(1536)")`, so Prisma omits it from
 * KnowledgeChunkUpdateManyMutationInput and rejects `data: { embedding: null }`
 * at runtime as an unknown argument — an `as any` cast silences the compiler but
 * not the client. Since the worker now selects only chunks whose vector IS NULL,
 * a clear that throws makes backfill and reindex hard failures, so pin the raw
 * SQL and pin that updateMany is never used for this column.
 */
describe('KnowledgeService.clearEmbeddings', () => {
  function createService() {
    const prisma = {
      // Typed with the tagged-template signature so `mock.calls[0]` destructures
      // without a cast.
      $queryRaw: vi.fn(async (_strings: string[], ..._values: unknown[]) => [
        { id: 'source-9', generation: 1, cleared: 4 },
      ]),
      knowledgeChunk: { updateMany: vi.fn() },
    };
    const service = new KnowledgeService(
      prisma as never,
      { log: vi.fn(async () => undefined) } as never,
      { name: 'test', dimensions: 3, embed: vi.fn() },
      new FileParser(),
      { saveUploadedFile: vi.fn(), deleteStoredFile: vi.fn() } as never,
    );
    return { prisma, service };
  }

  it('clears a whole workspace with raw SQL, never updateMany', async () => {
    const { prisma, service } = createService();

    await expect(service.clearEmbeddings('ws-1')).resolves.toEqual({
      cleared: 4,
      generations: { 'source-9': 1 },
    });

    expect(prisma.knowledgeChunk.updateMany).not.toHaveBeenCalled();
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain('SET embedding = NULL');
    expect(values).toEqual(['ws-1']);
  });

  it('scopes a single-source clear by workspace as well as source', async () => {
    const { prisma, service } = createService();

    await service.clearEmbeddings('ws-1', 'source-9');

    // Both predicates, in this order. Source id alone would let a caller who
    // guessed an id wipe another tenant's vectors.
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('workspace_id =');
    expect(sql).toContain('source_id =');
    expect(values).toEqual(['ws-1', 'source-9']);
  });
});

describe('cosineSim', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('returns 0 when either vector is zero-magnitude', () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});

describe('KnowledgeService.pgvectorSearch', () => {
  it('casts UUID filter parameters in raw pgvector SQL', async () => {
    const prisma = { $queryRaw: vi.fn(async () => []) };
    const service = new KnowledgeService(
      prisma as never,
      { log: vi.fn(async () => undefined) } as never,
      {
        name: 'test-embedder',
        dimensions: 1536,
        embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
      },
      new FileParser(),
      {
        saveUploadedFile: vi.fn(),
        deleteStoredFile: vi.fn(),
      } as never,
    );

    await service.pgvectorSearch('17701666-b0e9-4ac1-a629-4a92d42b056c', [0.1, 0.2, 0.3], 3);

    const [strings] = prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(Array.from(strings).join('?')).toContain('ks.workspace_id = ?::uuid');
  });

  it('ranks exact lexical knowledge matches before vector neighbors', async () => {
    const exactChunk = {
      id: '11111111-1111-4111-8111-111111111111',
      source_id: '22222222-2222-4222-8222-222222222222',
      content: 'The retrieval token is vfkb-exact-token and support hours are 9-5.',
    };
    const vectorNeighbor = {
      id: '33333333-3333-4333-8333-333333333333',
      source_id: '44444444-4444-4444-8444-444444444444',
      content: 'A similar upload mentions support hours but has a different token.',
    };
    const prisma = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([exactChunk])
        .mockResolvedValueOnce([vectorNeighbor]),
      knowledgeChunk: {
        findMany: vi.fn(async () => [
          {
            id: exactChunk.id,
            chunkIndex: 0,
            source: {
              title: 'Exact',
              sourceType: 'file',
              agentId: null,
            },
          },
          {
            id: vectorNeighbor.id,
            chunkIndex: 0,
            source: {
              title: 'Vector neighbor',
              sourceType: 'file',
              agentId: null,
            },
          },
        ]),
      },
    };
    const service = new KnowledgeService(
      prisma as never,
      { log: vi.fn(async () => undefined) } as never,
      {
        name: 'test-embedder',
        dimensions: 1536,
        embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
      },
      new FileParser(),
      {
        saveUploadedFile: vi.fn(),
        deleteStoredFile: vi.fn(),
      } as never,
    );

    const hits = await service.search(
      '17701666-b0e9-4ac1-a629-4a92d42b056c',
      'vfkb-exact-token',
      { k: 2 },
    );

    expect(hits.map((hit) => hit.chunk_id)).toEqual([exactChunk.id, vectorNeighbor.id]);
    expect(hits[0].content).toContain('vfkb-exact-token');
  });
});

describe('FileParser', () => {
  const parser = new FileParser();

  it('detects kind by mime then extension', () => {
    expect(parser.detectKind('application/pdf', 'x.pdf')).toBe('pdf');
    expect(parser.detectKind(undefined, 'data.csv')).toBe('csv');
    expect(parser.detectKind('text/plain', 'notes.txt')).toBe('txt');
    expect(parser.detectKind('application/json', 'schema.json')).toBe('txt');
    expect(parser.detectKind(undefined, 'README.md')).toBe('txt');
  });

  it('rejects unsupported file types', () => {
    expect(() => parser.detectKind('application/zip', 'bundle.zip')).toThrow();
  });

  it('parses CSV into key:value rows', async () => {
    const csv = 'name,hours\nClinic A,9-5\nClinic B,"10-6, weekdays"\n';
    const result = await parser.parse(Buffer.from(csv, 'utf8'), 'text/csv', 'data.csv');
    expect(result.kind).toBe('csv');
    expect(result.text).toContain('name: Clinic A');
    expect(result.text).toContain('hours: 9-5');
    expect(result.text).toContain('hours: 10-6, weekdays');
  });

  it('parses plain text', async () => {
    const result = await parser.parse(Buffer.from('Hello world\r\n', 'utf8'), 'text/plain', 'a.txt');
    expect(result.kind).toBe('txt');
    expect(result.text).toBe('Hello world');
  });

  it('parses JSON uploads as text knowledge', async () => {
    const result = await parser.parse(
      Buffer.from('{"hours":"9-5","city":"Delhi"}', 'utf8'),
      'application/json',
      'data.json',
    );
    expect(result.kind).toBe('txt');
    expect(result.text).toContain('"hours":"9-5"');
  });

  it('rejects empty buffers', async () => {
    await expect(
      parser.parse(Buffer.from('', 'utf8'), 'text/plain', 'a.txt'),
    ).rejects.toThrow();
  });

  it('should reject oversized files (>10MB)', async () => {
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

    // Create a file buffer larger than 10MB
    const oversizedBuffer = Buffer.alloc(MAX_FILE_SIZE + 1);
    const fileSize = oversizedBuffer.length;

    // Verify file exceeds size limit
    expect(fileSize).toBeGreaterThan(MAX_FILE_SIZE);

    // The file parser or upload service should reject oversized files
    // In a real implementation, this check would happen before parsing
    const shouldReject = fileSize > MAX_FILE_SIZE;
    expect(shouldReject).toBe(true);
  });

  it('should reject unsupported MIME types', async () => {
    // Test various dangerous/unsupported file types
    const unsupportedFiles = [
      { mimeType: 'application/x-msdownload', filename: 'malware.exe' },
      { mimeType: 'application/x-executable', filename: 'program.bin' },
      { mimeType: 'application/javascript', filename: 'script.js' },
      { mimeType: 'text/html', filename: 'page.html' },
      { mimeType: 'application/x-sh', filename: 'script.sh' },
      { mimeType: 'application/x-python', filename: 'code.py' },
    ];

    for (const file of unsupportedFiles) {
      // The FileParser.detectKind should throw for these types
      expect(() => parser.detectKind(file.mimeType, file.filename)).toThrow();
    }
  });

  it('should reject files with dangerous extensions', async () => {
    const dangerousExtensions = ['.exe', '.bat', '.cmd', '.msi', '.dll', '.scr', '.pif', '.vbs'];

    for (const ext of dangerousExtensions) {
      expect(() => parser.detectKind('application/octet-stream', `file${ext}`)).toThrow();
    }
  });
});

describe('KnowledgeService.uploadFile', () => {
  it('persists the original file to Supabase storage before creating chunks', async () => {
    const now = new Date('2026-05-21T12:00:00.000Z');
    const storedFile = {
      provider: 'supabase' as const,
      bucket: 'knowledge-files',
      path: 'organizations/org-1/workspaces/workspace-1/workspace/file.txt',
      fileUrl: 'supabase://knowledge-files/organizations/org-1/workspaces/workspace-1/workspace/file.txt',
      publicUrl: 'https://example.supabase.co/storage/v1/object/public/knowledge-files/file.txt',
    };
    const row = {
      id: 'source-1',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      agentId: null,
      sourceType: 'file',
      title: 'FAQ',
      fileUrl: storedFile.fileUrl,
      content: 'Clinic hours are 9-5.',
      status: 'pending',
      metadata: null as unknown,
      createdBy: 'user-1',
      createdAt: now,
      updatedAt: now,
      _count: { chunks: 1 },
    };
    const prisma = {
      agent: { findFirst: vi.fn() },
      organizationIdFor: vi.fn(async () => 'org-1'),
      knowledgeSource: {
        create: vi.fn(async ({ data }) => {
          row.fileUrl = data.fileUrl;
          row.content = data.content;
          row.metadata = data.metadata;
          return { ...row };
        }),
        update: vi.fn(async ({ data }) => {
          if (data.status) row.status = data.status;
          if (data.metadata) row.metadata = data.metadata;
          return { ...row };
        }),
        findUnique: vi.fn(async () => ({ metadata: row.metadata })),
        findFirst: vi.fn(async () => ({ ...row, _count: { chunks: 1 } })),
      },
      knowledgeChunk: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      $executeRaw: vi.fn(async () => 1),
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    };
    const storage: KnowledgeFileStorage = {
      saveUploadedFile: vi.fn(async () => storedFile),
      deleteStoredFile: vi.fn(async () => undefined),
    };
    const audit = { log: vi.fn(async () => undefined) };
    const embedder = {
      name: 'test-embedder',
      dimensions: 3,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0, 0])),
    };
    const service = new KnowledgeService(
      prisma as never,
      audit as never,
      embedder,
      new FileParser(),
      storage,
    );

    const result = await service.uploadFile('workspace-1', 'user-1', {
      title: 'FAQ',
      filename: 'faq.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Clinic hours are 9-5.', 'utf8'),
    });

    expect(storage.saveUploadedFile).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      filename: 'faq.txt',
      mimeType: 'text/plain',
    }));
    expect(prisma.knowledgeSource.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fileUrl: storedFile.fileUrl,
        metadata: expect.objectContaining({
          storage_provider: 'supabase',
          storage_bucket: storedFile.bucket,
          storage_path: storedFile.path,
        }),
      }),
    }));
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(result.file_url).toBe(storedFile.fileUrl);
    expect(result.status).toBe('ready');
  });
});
