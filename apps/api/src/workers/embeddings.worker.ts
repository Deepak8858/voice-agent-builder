import { type Job } from 'bullmq';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { OpenAiEmbeddingsAdapter } from '../llm/adapters/openai-embeddings.adapter';
import { Prisma } from '@prisma/client';

export const EMBEDDINGS_QUEUE = 'embeddings';

const BATCH_SIZE = 64;

/**
 * `sourceId` may be absent (whole-workspace backfill) but never blank: the
 * source filter below is built from a truthiness test, so `sourceId: ''` would
 * silently widen one malformed job into "re-embed every null vector in the
 * workspace". `.uuid()` also rejects a blank string, so a payload that fails
 * here fails the job instead of scoping itself away.
 */
const GenerateEmbeddingsJobSchema = z.object({
  workspaceId: z.string().uuid(),
  sourceId: z.string().uuid().optional(),
  /**
   * `KnowledgeSource.embeddingGeneration` as of the reset that queued this job.
   * Optional, not required: jobs queued before this field existed are still in
   * Redis and must not fail validation on retry. When it is absent (or when the
   * job covers the whole workspace, where one number cannot describe many
   * sources) the worker snapshots each source's generation the first time it
   * sees it, which still stops the drain if a reset lands mid-job.
   */
  generation: z.number().int().nonnegative().optional(),
});

interface GenerateEmbeddingsJob {
  /** Tenant scope. Required — every query is filtered by it. */
  workspaceId: string;
  /** Limit processing to this sourceId (optional — omit for the whole workspace). */
  sourceId?: string;
  /** Generation of the reset that queued this job (optional — see the schema). */
  generation?: number;
}

@Injectable()
export class EmbeddingsWorker extends BaseWorker<GenerateEmbeddingsJob> {
  constructor(
    queueService: QueueService,
    private readonly prisma: PrismaService,
    private readonly embedder: OpenAiEmbeddingsAdapter,
  ) {
    super(EMBEDDINGS_QUEUE, queueService, 3);
  }

  async processor(job: Job<GenerateEmbeddingsJob>): Promise<void> {
    // Fail loudly rather than fall back to "all workspaces": a job queued before
    // the payload carried workspaceId must not re-embed other tenants' chunks,
    // and a blank sourceId must not widen a one-source job into the whole
    // workspace.
    const parsed = GenerateEmbeddingsJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(
        `[EmbeddingsWorker] malformed job payload — refusing to run: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const { workspaceId, sourceId, generation } = parsed.data;

    const sourceClause = sourceId ? Prisma.sql`AND source_id = ${sourceId}::uuid` : Prisma.empty;
    const stamp = JSON.stringify({ embedder: this.embedder.name, dimensions: this.embedder.dimensions });
    let updated = 0;
    // Generation this job is rebuilding, per source. clearEmbeddings bumps it in
    // the same statement that nulls the vectors, so a value that moved means a
    // newer reset owns the rebuild and everything in flight here was computed
    // from content that reset superseded.
    const owned = new Map<string, number>();
    if (sourceId && generation !== undefined) owned.set(sourceId, generation);

    this.logger.log(`[EmbeddingsWorker] embedding null vectors (workspace=${workspaceId}, sourceId=${sourceId ?? 'all'})`);

    while (true) {
      // embedding is Unsupported("vector(1536)") — Prisma cannot filter on it, so
      // the IS NULL predicate only exists in raw SQL. No offset: each embedded row
      // leaves the result set, so skipping ahead would skip unprocessed rows.
      const chunks = await this.prisma.$queryRaw<Array<{ id: string; content: string; source_id: string }>>`
        SELECT id, content, source_id
        FROM knowledge_chunks
        WHERE workspace_id = ${workspaceId}::uuid
          AND embedding IS NULL
          ${sourceClause}
        LIMIT ${BATCH_SIZE}
      `;
      if (chunks.length === 0) break;

      const vectors = await this.embedder.generateEmbeddings(chunks.map((c) => c.content));
      if (vectors.length !== chunks.length) {
        throw new Error(`[EmbeddingsWorker] embedder returned ${vectors.length} vector(s) for ${chunks.length} chunk(s).`);
      }

      // Re-read immediately before the write, not once at job start: the reset
      // this job is racing can land at any point while it drains.
      // ponytail: leaves a one-round-trip window between this check and the
      // UPDATE. Closing it needs `AND ks.embedding_generation = $n` inside the
      // UPDATE, which would trip the "wrote no embeddings" abort below instead of
      // stopping cleanly — add it if that window ever shows up in practice.
      const current = await this.prisma.knowledgeSource.findMany({
        where: { workspaceId, id: { in: [...new Set(chunks.map((c) => c.source_id))] } },
        select: { id: true, embeddingGeneration: true },
      });
      const stale = current.find((s) => owned.has(s.id) && owned.get(s.id) !== s.embeddingGeneration);
      if (stale) {
        this.logger.warn(
          `[EmbeddingsWorker] source ${stale.id} moved to generation ${stale.embeddingGeneration} (this job owns ${owned.get(stale.id)}) — stopping after ${updated} chunk(s); a newer job owns the rebuild`,
        );
        return;
      }
      for (const s of current) owned.set(s.id, s.embeddingGeneration);

      const writes = await Promise.all(
        chunks.map((c, i) => this.prisma.$executeRaw`
          UPDATE knowledge_chunks
          SET embedding = ${`[${vectors[i].join(',')}]`}::vector,
              metadata = COALESCE(metadata, '{}'::jsonb) || ${stamp}::jsonb
          WHERE id = ${c.id}::uuid AND workspace_id = ${workspaceId}::uuid
        `),
      );
      const written = writes.reduce((sum, n) => sum + Number(n), 0);
      // A batch that writes nothing would be returned by the next SELECT forever.
      if (written === 0) {
        throw new Error(`[EmbeddingsWorker] batch of ${chunks.length} chunk(s) wrote no embeddings — aborting.`);
      }

      updated += written;
      this.logger.debug(`[EmbeddingsWorker] batch done: ${updated} chunk(s) embedded`);
    }
  }
}
