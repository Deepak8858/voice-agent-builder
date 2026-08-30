import { type Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { OpenAiEmbeddingsAdapter } from '../llm/adapters/openai-embeddings.adapter';
import { Prisma } from '@prisma/client';

export const EMBEDDINGS_QUEUE = 'embeddings';

const BATCH_SIZE = 64;

interface GenerateEmbeddingsJob {
  /** Tenant scope. Required — every query is filtered by it. */
  workspaceId: string;
  /** Limit processing to this sourceId (optional — omit for the whole workspace). */
  sourceId?: string;
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
    const { workspaceId, sourceId } = job.data;
    // Fail loudly rather than fall back to "all workspaces": a job queued before
    // the payload carried workspaceId must not re-embed other tenants' chunks.
    if (!workspaceId) {
      throw new Error('[EmbeddingsWorker] job is missing workspaceId — refusing to run unscoped.');
    }

    const sourceClause = sourceId ? Prisma.sql`AND source_id = ${sourceId}::uuid` : Prisma.empty;
    const stamp = JSON.stringify({ embedder: this.embedder.name, dimensions: this.embedder.dimensions });
    let updated = 0;

    this.logger.log(`[EmbeddingsWorker] embedding null vectors (workspace=${workspaceId}, sourceId=${sourceId ?? 'all'})`);

    while (true) {
      // embedding is Unsupported("vector(1536)") — Prisma cannot filter on it, so
      // the IS NULL predicate only exists in raw SQL. No offset: each embedded row
      // leaves the result set, so skipping ahead would skip unprocessed rows.
      const chunks = await this.prisma.$queryRaw<Array<{ id: string; content: string }>>`
        SELECT id, content
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
