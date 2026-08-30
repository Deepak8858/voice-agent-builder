import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { KnowledgeController } from './knowledge.controller';
import { EMBEDDINGS_QUEUE } from '../workers/embeddings.worker';

const WORKSPACE_ID = '17701666-b0e9-4ac1-a629-4a92d42b056c';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';

const knowledge = {
  get: vi.fn(async () => ({ id: SOURCE_ID })),
  clearEmbeddings: vi.fn(async () => ({ cleared: 3, generations: { [SOURCE_ID]: 5 } })),
};
const queue = { enqueue: vi.fn(async () => undefined) };
const audit = { log: vi.fn(async () => undefined) };

function build(): KnowledgeController {
  return new KnowledgeController(knowledge as never, queue as never, audit as never);
}

const user = { id: 'user-1' } as never;

const proto = KnowledgeController.prototype;

/**
 * WorkspaceGuard alone proves membership, not seat, so until these bindings
 * landed a viewer could null every vector in the workspace through backfill.
 * The bindings are pinned by metadata on the real class: a RoleGuard the test
 * constructs by hand says nothing about whether Nest runs it on this route.
 */
describe('KnowledgeController authorization', () => {
  it('is protected by the workspace guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, KnowledgeController) ?? []).toContain(
      WorkspaceGuard,
    );
  });

  it.each([
    { handler: 'create', roles: ['owner', 'admin', 'editor'], fresh: false },
    { handler: 'upload', roles: ['owner', 'admin', 'editor'], fresh: false },
    { handler: 'update', roles: ['owner', 'admin', 'editor'], fresh: false },
    { handler: 'remove', roles: ['owner', 'admin'], fresh: true },
    { handler: 'reindex', roles: ['owner', 'admin'], fresh: true },
    { handler: 'backfill', roles: ['owner', 'admin'], fresh: true },
  ] as const)('binds RoleGuard on $handler with roles $roles', ({ handler, roles, fresh }) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[handler])).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, proto[handler])).toEqual({ roles, fresh });
  });

  it.each(['list', 'get', 'search', 'listForAgent'] as const)(
    'leaves %s open to every member',
    (handler) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, proto[handler])).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, proto[handler])).toBeUndefined();
    },
  );
});

/**
 * Runs the real RoleGuard against the real metadata on each handler, so a
 * widened role set fails here even though the binding assertions above still
 * pass — see crm-routing.controller.test.ts for the pattern.
 */
function guardContext(handler: keyof KnowledgeController, membershipRole: string | null) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const req = {
    params: { workspaceId: WORKSPACE_ID },
    user: {
      id: 'user-1',
      active_workspace_id: WORKSPACE_ID,
      active_workspace_role: membershipRole,
    },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => proto[handler],
    getClass: () => KnowledgeController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('KnowledgeController RoleGuard enforcement', () => {
  const destructive = ['remove', 'reindex', 'backfill'] as const;

  it.each(destructive)('%s denies a viewer', async (handler) => {
    const { guard, ctx } = guardContext(handler, 'viewer');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  // The tier split is the point: an editor may author content but must not
  // destroy embeddings.
  it.each(destructive)('%s denies an editor', async (handler) => {
    const { guard, ctx } = guardContext(handler, 'editor');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(destructive)('%s allows an admin', async (handler) => {
    const { guard, ctx } = guardContext(handler, 'admin');

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it.each(['create', 'upload', 'update'] as const)('%s denies a viewer', async (handler) => {
    const { guard, ctx } = guardContext(handler, 'viewer');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['create', 'upload', 'update'] as const)('%s allows an editor', async (handler) => {
    const { guard, ctx } = guardContext(handler, 'editor');

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });
});

describe('KnowledgeController embedding jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reindex enqueues a workspace-scoped job for one source', async () => {
    await build().reindex(WORKSPACE_ID, SOURCE_ID, user);

    expect(knowledge.get).toHaveBeenCalledWith(WORKSPACE_ID, SOURCE_ID);
    expect(queue.enqueue).toHaveBeenCalledWith(EMBEDDINGS_QUEUE, 'generate-embeddings', {
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID,
      generation: 5,
    });
  });

  /**
   * The job must carry the generation this clear produced, not one the worker
   * reads later: a worker that adopts whatever it sees on its first batch has
   * already lost the race it is meant to detect, and keeps writing vectors a
   * newer reset superseded.
   */
  it('reindex stamps the job with the generation the clear just produced', async () => {
    knowledge.clearEmbeddings.mockResolvedValueOnce({
      cleared: 1,
      generations: { [SOURCE_ID]: 9 },
    });

    await build().reindex(WORKSPACE_ID, SOURCE_ID, user);

    expect(queue.enqueue).toHaveBeenCalledWith(
      EMBEDDINGS_QUEUE,
      'generate-embeddings',
      expect.objectContaining({ generation: 9 }),
    );
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
    // The per-source map, not a single generation: each source lands on its
    // own number and the worker seeds its ownership check from this map, so a
    // job that starts after a newer reset refuses that source immediately.
    expect(queue.enqueue).toHaveBeenCalledWith(EMBEDDINGS_QUEUE, 'generate-embeddings', {
      workspaceId: WORKSPACE_ID,
      generations: { [SOURCE_ID]: 5 },
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
