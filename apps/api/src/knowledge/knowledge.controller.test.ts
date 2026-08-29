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
const audit = { log: vi.fn(async () => undefined) };

function build(): KnowledgeController {
  return new KnowledgeController(knowledge as never, queue as never, audit as never);
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

  /**
   * Both handlers destroy persisted vectors. Without an audit row there is no
   * record of who wiped a workspace's embeddings, and the scope has to be on the
   * row too — one source and the whole workspace are very different blast radii.
   */
  it('reindex records the actor and the source scope', async () => {
    await build().reindex(WORKSPACE_ID, SOURCE_ID, user);

    expect(audit.log).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      actorUserId: 'user-1',
      action: 'knowledge_source.reindex',
      resourceType: 'knowledge_source',
      resourceId: SOURCE_ID,
      metadata: { scope: 'source', cleared_chunks: 3, enqueued: true },
    });
  });

  it('backfill records the actor and the workspace scope', async () => {
    await build().backfill(WORKSPACE_ID, user);

    expect(audit.log).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      actorUserId: 'user-1',
      action: 'knowledge_source.backfill',
      resourceType: 'workspace',
      resourceId: WORKSPACE_ID,
      metadata: { scope: 'workspace', cleared_chunks: 3, enqueued: true },
    });
  });

  /**
   * The vectors are already gone once the enqueue is attempted, so a failed
   * enqueue is exactly when the audit row matters most: the workspace is left
   * unembedded and someone has to know who did it.
   */
  it('records enqueued: false when the enqueue fails, and still raises the error', async () => {
    queue.enqueue.mockRejectedValueOnce(new Error('redis down'));

    await expect(build().backfill(WORKSPACE_ID, user)).rejects.toThrow('redis down');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'knowledge_source.backfill',
        metadata: { scope: 'workspace', cleared_chunks: 3, enqueued: false },
      }),
    );
  });
});
