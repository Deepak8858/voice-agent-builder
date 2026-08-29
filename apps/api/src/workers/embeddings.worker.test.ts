import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type Job } from 'bullmq';
import { EmbeddingsWorker } from './embeddings.worker';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const WORKSPACE_ID = '17701666-b0e9-4ac1-a629-4a92d42b056c';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';

const mockQueueService = {
  getBullMqConnection: vi.fn().mockReturnValue({}),
};

const prisma = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(async () => 1),
};

const embedder = {
  name: 'test-embedder',
  dimensions: 3,
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
};

function build(): EmbeddingsWorker {
  return new EmbeddingsWorker(mockQueueService as never, prisma as never, embedder as never);
}

function job(data: Record<string, unknown>): Job<never> {
  return { id: 'job-1', data } as unknown as Job<never>;
}

/** Flatten a tagged-template call into inspectable SQL (values become `?`). */
function sqlOf(call: unknown[]): string {
  return Array.from(call[0] as TemplateStringsArray).join('?');
}

describe('EmbeddingsWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$executeRaw.mockResolvedValue(1);
  });

  it('scopes the batch query to the workspace and to null vectors only', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await build().processor(job({ workspaceId: WORKSPACE_ID }));

    const call = prisma.$queryRaw.mock.calls[0] as unknown[];
    expect(sqlOf(call)).toContain('workspace_id = ?::uuid');
    expect(sqlOf(call)).toContain('embedding IS NULL');
    expect(call).toContain(WORKSPACE_ID);
  });

  it('adds the source filter when the job carries a sourceId', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await build().processor(job({ workspaceId: WORKSPACE_ID, sourceId: SOURCE_ID }));

    const values = (prisma.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    const nested = values.find((v) => !!v && typeof v === 'object' && 'strings' in v) as {
      strings: string[];
      values: unknown[];
    };
    expect(nested.strings.join('?')).toContain('source_id = ?::uuid');
    expect(nested.values).toContain(SOURCE_ID);
  });

  it('throws on a job with no workspaceId instead of running unscoped', async () => {
    await expect(build().processor(job({ sourceId: SOURCE_ID }))).rejects.toThrow(/workspaceId/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(embedder.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('drains a shrinking result set without skipping rows', async () => {
    // The predicate is "embedding IS NULL", so embedded rows leave the result set:
    // the worker must re-query from the top, never advance an offset.
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { id: 'a', content: 'one' },
        { id: 'b', content: 'two' },
      ])
      .mockResolvedValueOnce([{ id: 'c', content: 'three' }])
      .mockResolvedValueOnce([]);

    await build().processor(job({ workspaceId: WORKSPACE_ID }));

    expect(embedder.generateEmbeddings.mock.calls).toEqual([[['one', 'two']], [['three']]]);
    // Identical query every time — an interpolated offset would differ here.
    const [first, ...rest] = prisma.$queryRaw.mock.calls as unknown[][];
    for (const call of rest) expect(call).toEqual(first);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    const updatedIds = prisma.$executeRaw.mock.calls.flatMap((c) => (c as unknown[]).slice(1));
    expect(updatedIds).toContain('a');
    expect(updatedIds).toContain('b');
    expect(updatedIds).toContain('c');
  });

  it('merges the embedder stamp into metadata instead of replacing it', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', content: 'one' }])
      .mockResolvedValueOnce([]);

    await build().processor(job({ workspaceId: WORKSPACE_ID }));

    const call = prisma.$executeRaw.mock.calls[0] as unknown[];
    expect(sqlOf(call)).toContain("COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
    expect(sqlOf(call)).toContain('workspace_id = ?::uuid');
    expect(call).toContain(JSON.stringify({ embedder: 'test-embedder', dimensions: 3 }));
  });

  it('stops instead of looping forever when a batch writes no embeddings', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'a', content: 'one' }]);
    prisma.$executeRaw.mockResolvedValue(0);

    await expect(build().processor(job({ workspaceId: WORKSPACE_ID }))).rejects.toThrow(/no embeddings/);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
