import { describe, expect, it, vi } from 'vitest';
import { KnowledgeService } from './knowledge.service';
import { FileParser } from './parsers/file-parser';

/**
 * The embedding reset is "null every vector, then let the worker re-embed the
 * null ones". Two resets overlap: the worker draining the first still holds text
 * it selected before the second landed, and its UPDATE would store a vector for
 * superseded content — and make the chunk non-null, so the second reset's job
 * skips it and the stale vector sticks. `embedding_generation` is what the worker
 * compares to detect that, so the bump has to happen, has to be per source, and
 * has to be in the same statement as the null-out: a worker reading the counter
 * between two statements would see the old generation and a null vector, i.e. a
 * rebuild it wrongly believes it owns.
 */
describe('KnowledgeService.clearEmbeddings generation marker', () => {
  function createService() {
    const prisma = {
      $executeRaw: vi.fn(async (_strings: string[], ..._values: unknown[]) => 4),
      knowledgeSource: { update: vi.fn(), updateMany: vi.fn() },
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

  it('bumps the source generation in the same statement that nulls the vectors', async () => {
    const { prisma, service } = createService();

    await service.clearEmbeddings('ws-1', 'source-9');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('embedding_generation = embedding_generation + 1');
    expect(sql).toContain('SET embedding = NULL');
    // Both halves tenant-scoped, and the source predicate on the bump — a bump
    // by id alone would let a guessed id touch another tenant's source.
    expect(sql).toContain('workspace_id = ?::uuid AND id = ?::uuid');
    expect(values).toEqual(['ws-1', 'source-9']);
    // Never through the Prisma model API: the vector null-out cannot go through
    // it (Unsupported column), so splitting the bump off would split the write.
    expect(prisma.knowledgeSource.update).not.toHaveBeenCalled();
    expect(prisma.knowledgeSource.updateMany).not.toHaveBeenCalled();
  });

  it('bumps every source it clears on the workspace-wide backfill path', async () => {
    const { prisma, service } = createService();

    await service.clearEmbeddings('ws-1');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('embedding_generation = embedding_generation + 1');
    // The counter is per source, so the workspace path bumps each of them and
    // clears only the chunks under a source it bumped.
    expect(sql).toContain('source_id = ANY (SELECT id FROM bumped)');
    expect(sql).toContain('workspace_id = ANY (SELECT workspace_id FROM bumped)');
    expect(values).toEqual(['ws-1']);
  });
});
