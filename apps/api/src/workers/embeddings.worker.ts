import { type Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { OpenAiEmbeddingsAdapter } from '../llm/adapters/openai-embeddings.adapter';
import { Prisma } from '@prisma/client';

export const EMBEDDINGS_QUEUE = 'embeddings';

const BATCH_SIZE = 64;

interface GenerateEmbeddingsJob {
  /** Limit processing to this sourceId (optional — omit to process all). */
  sourceId?: string;
  /** Regenerate even when embedding is already set. */
  force?: boolean;
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
    const { sourceId, force } = job.data;
    let updated = 0;

    const where: Prisma.KnowledgeChunkWhereInput = {};
    if (sourceId) where.sourceId = sourceId;

    const total = await this.prisma.knowledgeChunk.count({ where });
    this.logger.log(`[EmbeddingsWorker] Processing ${total} chunk(s) (force=${force}, sourceId=${sourceId ?? 'all'})`);

    let offset = 0;
    while (true) {
      const chunks = await this.prisma.knowledgeChunk.findMany({
        where,
        skip: offset,
        take: BATCH_SIZE,
        select: { id: true, content: true },
      });
      if (chunks.length === 0) break;

      const texts = chunks.map((c) => c.content);
      const vectors = await this.embedder.generateEmbeddings(texts);

      await Promise.all(
        chunks.map(async (c, i) => {
          await this.prisma.$executeRaw`
            UPDATE knowledge_chunks
            SET embedding = ${JSON.stringify(vectors[i])}, metadata = ${JSON.stringify({ embedder: this.embedder.name, dimensions: this.embedder.dimensions })}
            WHERE id = ${c.id}
          `;
        }),
      );

      updated += chunks.length;
      offset += BATCH_SIZE;
      this.logger.debug(`[EmbeddingsWorker] batch done: ${updated}/${total}`);
    }
  }
}