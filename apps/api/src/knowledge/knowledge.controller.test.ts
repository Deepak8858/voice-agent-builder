import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeController } from './knowledge.controller';
import { EMBEDDINGS_QUEUE } from '../workers/embeddings.worker';

const WORKSPACE_ID = '17701666-b0e9-4ac1-a629-4a92d42b056c';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';

const knowledge = {
  get: vi.fn(async () => ({ id: SOURCE_ID })),
  clearEmbeddings: vi.fn(async () => 3),
};
const queue = { enqueue: vi.fn(async () => undefined) };

function build(): KnowledgeController {
  return new KnowledgeController(knowledge as never, queue as never);
}

const user = { id: 'user-1' } as never;

describe('KnowledgeController embedding jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reindex enqueues a workspace-scoped job for one source', async () => {
    await build().reindex(WORKSPACE_ID, SOURCE_ID, user);

    expect(knowledge.get).toHaveBeenCalledWith(WORKSPACE_ID, SOURCE_ID);
    expect(queue.enqueue).toHaveBeenCalledWith(EMBEDDINGS_QUEUE, 'generate-embeddings', {
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID,
    });
  });

  it('reindex clears the source vectors, or the worker would select nothing', async () => {
    // The worker only embeds chunks whose vector IS NULL and ingest always
    // writes one, so an enqueue with no clear is a 202 that does nothing.
    await build().reindex(WORKSPACE_ID, SOURCE_ID, user);

    expect(knowledge.clearEmbeddings).toHaveBeenCalledWith(WORKSPACE_ID, SOURCE_ID);
  });

  it('reindex proves ownership before clearing anything', async () => {
    knowledge.get.mockRejectedValueOnce(new Error('not found'));

    await expect(build().reindex(WORKSPACE_ID, SOURCE_ID, user)).rejects.toThrow();
    expect(knowledge.clearEmbeddings).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('backfill clears this workspace only and enqueues a workspace-scoped job', async () => {
    await build().backfill(WORKSPACE_ID, user);

    expect(knowledge.clearEmbeddings).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(queue.enqueue).toHaveBeenCalledWith(EMBEDDINGS_QUEUE, 'generate-embeddings', {
      workspaceId: WORKSPACE_ID,
    });
  });
});
