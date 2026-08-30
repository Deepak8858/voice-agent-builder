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
  knowledgeSource: { findMany: vi.fn(async () => [] as Array<{ id: string; embeddingGeneration: number }>) },
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
    // mockReset, not just clearAllMocks: a test that stops early leaves its
    // unconsumed mockResolvedValueOnce queued, and it would then answer the next
    // test's first query.
    prisma.$queryRaw.mockReset();
    prisma.knowledgeSource.findMany.mockReset();
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.knowledgeSource.findMany.mockResolvedValue([]);
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

  /**
   * The source filter is built from a truthiness test, so a blank sourceId used
   * to mean "no filter" — one malformed job re-embedding every null vector in
   * the workspace instead of one source's. It must fail the job, not widen it.
   */
  it.each([
    ['blank', ''],
    ['not a uuid', 'source-1'],
  ])('throws instead of dropping the source filter when sourceId is %s', async (_label, bad) => {
    await expect(
      build().processor(job({ workspaceId: WORKSPACE_ID, sourceId: bad })),
    ).rejects.toThrow(/sourceId/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(embedder.generateEmbeddings).not.toHaveBeenCalled();
  });

  it('throws when workspaceId is not a uuid', async () => {
    await expect(build().processor(job({ workspaceId: 'ws-1' }))).rejects.toThrow(/workspaceId/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
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

  /**
   * The reset flow is "null every vector, bump the source's generation, enqueue".
   * A worker still draining the previous reset holds chunk text selected before
   * the new one landed; writing its vectors would both store superseded content
   * AND make the chunk non-null, so the newer job's `embedding IS NULL` filter
   * skips it and the stale vector never gets corrected.
   */
  it('writes nothing and stops when the source moved to a newer generation', async () => {
    // Bounded so a worker that ignored the generation finishes and fails the
    // assertions below instead of looping on a result set that never shrinks.
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', content: 'one', source_id: SOURCE_ID }])
      .mockResolvedValueOnce([]);
    prisma.knowledgeSource.findMany.mockResolvedValue([{ id: SOURCE_ID, embeddingGeneration: 7 }]);

    await build().processor(job({ workspaceId: WORKSPACE_ID, sourceId: SOURCE_ID, generation: 6 }));

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    // Stopped, not looped: a second SELECT would return the same rows forever.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('embeds normally when the source is still on the generation the job owns', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', content: 'one', source_id: SOURCE_ID }])
      .mockResolvedValueOnce([]);
    prisma.knowledgeSource.findMany.mockResolvedValue([{ id: SOURCE_ID, embeddingGeneration: 6 }]);

    await build().processor(job({ workspaceId: WORKSPACE_ID, sourceId: SOURCE_ID, generation: 6 }));

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // The generation re-read is tenant-scoped, like every other query here.
    expect(prisma.knowledgeSource.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE_ID, id: { in: [SOURCE_ID] } },
      select: { id: true, embeddingGeneration: true },
    });
  });

  /**
   * Jobs queued before the payload carried a generation are still in Redis, so
   * they must run — and still stop if a reset lands while they drain. The
   * generation seen on the first batch is the one such a job owns.
   */
  it('stops a generation-less job when the generation moves mid-drain', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'a', content: 'one', source_id: SOURCE_ID }])
      .mockResolvedValueOnce([{ id: 'b', content: 'two', source_id: SOURCE_ID }])
      .mockResolvedValueOnce([]);
    prisma.knowledgeSource.findMany
      .mockResolvedValueOnce([{ id: SOURCE_ID, embeddingGeneration: 3 }])
      .mockResolvedValueOnce([{ id: SOURCE_ID, embeddingGeneration: 4 }]);

    await build().processor(job({ workspaceId: WORKSPACE_ID, sourceId: SOURCE_ID }));

    // First batch owned generation 3 and was written; the second stopped.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  // The workspace-wide map short-circuits before any embedding work: a source
  // whose current generation moved past the job's map entry is refused on the
  // FIRST batch, not discovered one embed pass late by the snapshot fallback.
  it('refuses a workspace job whose generations map is already stale', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'a', content: 'one', source_id: SOURCE_ID }]);
    prisma.knowledgeSource.findMany.mockResolvedValueOnce([
      { id: SOURCE_ID, embeddingGeneration: 4 },
    ]);

    await build().processor(
      job({ workspaceId: WORKSPACE_ID, generations: { [SOURCE_ID]: 3 } }),
    );

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('stops instead of looping forever when a batch writes no embeddings', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'a', content: 'one' }]);
    prisma.$executeRaw.mockResolvedValue(0);

    await expect(build().processor(job({ workspaceId: WORKSPACE_ID }))).rejects.toThrow(/no embeddings/);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
