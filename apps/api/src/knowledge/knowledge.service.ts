import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import type {
  CreateKnowledgeSourceDto,
  KnowledgeSearchHit,
  KnowledgeSourceListQuery,
  KnowledgeSourceSummary,
  UpdateKnowledgeSourceDto,
} from '@voiceforge/shared';
import { AuditService } from '../audit/audit.service';
import {
  AgentNotFoundError,
  KnowledgeIngestFailedError,
  KnowledgeSourceNotFoundError,
} from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from './embeddings/embedding.provider.interface';
import {
  KNOWLEDGE_FILE_STORAGE_TOKEN,
  type KnowledgeFileStorage,
  type StoredKnowledgeFile,
} from './knowledge-file-storage.interface';
import { FileParser } from './parsers/file-parser';

const CHUNK_CHAR_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const MAX_EMBED_BATCH = 64;

interface UploadFileInput {
  buffer: Buffer;
  mimeType?: string;
  filename?: string;
  title: string;
  agentId?: string | null;
}

interface RawKnowledgeChunk {
  id: string;
  content: string;
  source_id: string;
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(EMBEDDING_PROVIDER_TOKEN) private readonly embedder: EmbeddingProvider,
    private readonly fileParser: FileParser,
    @Inject(KNOWLEDGE_FILE_STORAGE_TOKEN) private readonly fileStorage: KnowledgeFileStorage,
  ) {}

  async list(workspaceId: string, query: KnowledgeSourceListQuery): Promise<KnowledgeSourceSummary[]> {
    const where: Prisma.KnowledgeSourceWhereInput = { workspaceId };
    if (query.scope === 'agent' && query.agent_id) {
      where.agentId = query.agent_id;
    } else if (query.scope === 'workspace') {
      where.agentId = null;
    } else if (query.agent_id) {
      where.OR = [{ agentId: query.agent_id }, { agentId: null }];
    }

    const rows = await this.prisma.knowledgeSource.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { chunks: true } } },
    });
    return rows.map((r) => this.toSummary(r, r._count.chunks));
  }

  async get(workspaceId: string, sourceId: string): Promise<KnowledgeSourceSummary> {
    const row = await this.prisma.knowledgeSource.findFirst({
      where: { id: sourceId, workspaceId },
      include: { _count: { select: { chunks: true } } },
    });
    if (!row) throw new KnowledgeSourceNotFoundError(sourceId);
    return this.toSummary(row, row._count.chunks);
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    dto: CreateKnowledgeSourceDto,
  ): Promise<KnowledgeSourceSummary> {
    if (dto.agent_id) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: dto.agent_id, workspaceId },
      });
      if (!agent) throw new AgentNotFoundError(dto.agent_id);
    }

    const organizationId = await this.prisma.organizationIdFor(workspaceId);

    const created = await this.prisma.knowledgeSource.create({
      data: {
        workspaceId,
        organizationId,
        agentId: dto.agent_id ?? null,
        sourceType: dto.source_type,
        title: dto.title,
        fileUrl: dto.file_url ?? null,
        content: dto.content ?? null,
        status: 'pending',
        metadata: dto.metadata
          ? (dto.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        createdBy: actorUserId,
      },
    });

    if (dto.source_type === 'text' && dto.content) {
      await this.processSource(created.id, workspaceId, organizationId, dto.agent_id ?? null, dto.content);
    } else if (dto.source_type === 'url' && dto.file_url) {
      // URL-based ingest is not yet implemented; mark ready with no chunks so
      // the source is visible. Phase 10 will add a URL fetcher worker.
      await this.prisma.knowledgeSource.update({
        where: { id: created.id },
        data: { status: 'ready' },
      });
    }

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'knowledge_source.create',
      resourceType: 'knowledge_source',
      resourceId: created.id,
      metadata: {
        title: created.title,
        source_type: created.sourceType,
        agent_id: created.agentId,
      },
    });

    return this.get(workspaceId, created.id);
  }

  async uploadFile(
    workspaceId: string,
    actorUserId: string,
    input: UploadFileInput,
  ): Promise<KnowledgeSourceSummary> {
    if (input.agentId) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: input.agentId, workspaceId },
      });
      if (!agent) throw new AgentNotFoundError(input.agentId);
    }

    const parsed = await this.fileParser.parse(input.buffer, input.mimeType, input.filename);

    const organizationId = await this.prisma.organizationIdFor(workspaceId);

    const storedFile = await this.fileStorage.saveUploadedFile({
      workspaceId,
      organizationId,
      agentId: input.agentId ?? null,
      buffer: input.buffer,
      filename: input.filename ?? null,
      mimeType: input.mimeType ?? null,
    });

    let created: { id: string };
    try {
      created = await this.prisma.knowledgeSource.create({
        data: {
          workspaceId,
          organizationId,
          agentId: input.agentId ?? null,
          sourceType: 'file',
          title: input.title,
          fileUrl: storedFile.fileUrl,
          content: parsed.text,
          status: 'pending',
          metadata: this.fileMetadata(input, parsed, storedFile) as Prisma.InputJsonValue,
          createdBy: actorUserId,
        },
      });
    } catch (err) {
      await this.fileStorage.deleteStoredFile(storedFile);
      throw err;
    }

    await this.processSource(created.id, workspaceId, organizationId, input.agentId ?? null, parsed.text);

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'knowledge_source.upload',
      resourceType: 'knowledge_source',
      resourceId: created.id,
      metadata: {
        title: input.title,
        file_kind: parsed.kind,
        bytes: parsed.bytes,
        storage_provider: storedFile.provider,
        storage_bucket: storedFile.bucket,
        storage_path: storedFile.path,
        agent_id: input.agentId ?? null,
      },
    });

    return this.get(workspaceId, created.id);
  }

  async update(
    workspaceId: string,
    sourceId: string,
    actorUserId: string,
    dto: UpdateKnowledgeSourceDto,
  ): Promise<KnowledgeSourceSummary> {
    const existing = await this.prisma.knowledgeSource.findFirst({
      where: { id: sourceId, workspaceId },
    });
    if (!existing) throw new KnowledgeSourceNotFoundError(sourceId);

    if (dto.agent_id) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: dto.agent_id, workspaceId },
      });
      if (!agent) throw new AgentNotFoundError(dto.agent_id);
    }

    await this.prisma.knowledgeSource.update({
      where: { id: sourceId },
      data: {
        title: dto.title ?? existing.title,
        agentId: dto.agent_id === undefined ? existing.agentId : dto.agent_id,
        status: dto.status ?? existing.status,
        metadata:
          dto.metadata !== undefined
            ? (dto.metadata as Prisma.InputJsonValue)
            : undefined,
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'knowledge_source.update',
      resourceType: 'knowledge_source',
      resourceId: sourceId,
      metadata: dto as Record<string, unknown>,
    });

    return this.get(workspaceId, sourceId);
  }

  async remove(workspaceId: string, sourceId: string, actorUserId: string): Promise<void> {
    const existing = await this.prisma.knowledgeSource.findFirst({
      where: { id: sourceId, workspaceId },
    });
    if (!existing) throw new KnowledgeSourceNotFoundError(sourceId);

    const storedFile = existing.sourceType === 'file'
      ? this.storedFileFromMetadata(existing.fileUrl, existing.metadata)
      : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { sourceId } });
      await tx.knowledgeSource.delete({ where: { id: sourceId } });
    });

    if (storedFile) {
      await this.fileStorage.deleteStoredFile(storedFile);
    }

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'knowledge_source.delete',
      resourceType: 'knowledge_source',
      resourceId: sourceId,
    });
  }

  async listForAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<KnowledgeSourceSummary[]> {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
    if (!agent) throw new AgentNotFoundError(agentId);
    return this.list(workspaceId, { scope: 'all', agent_id: agentId });
  }

  /**
   * Reset embedding vectors to null for a workspace, or for one source within
   * it. Both the backfill and reindex endpoints call this before enqueueing the
   * worker, because the worker only selects chunks whose vector IS NULL —
   * without this it would find nothing, since processSource always writes a
   * vector at insert time.
   *
   * Raw SQL, not updateMany: `embedding` is `Unsupported("vector(1536)")`, so
   * Prisma omits it from KnowledgeChunkUpdateManyMutationInput and rejects
   * `data: { embedding: null }` at runtime as an unknown argument. Every other
   * write to this column goes through raw SQL for the same reason — see
   * insertChunkWithVector.
   *
   * Each cleared source's `embedding_generation` is incremented in the SAME
   * statement, via a data-modifying CTE. It has to be one statement: a worker
   * that read the generation between the bump and the null-out would believe it
   * still owns the rebuild and keep writing vectors computed from content this
   * reset supersedes — and because those writes make the chunk non-null again,
   * the job queued by this reset would skip them and the stale vector would
   * stick. The workspace path bumps every source it clears, which is the
   * granularity EmbeddingsWorker compares at.
   */
  async clearEmbeddings(workspaceId: string, sourceId?: string): Promise<number> {
    return sourceId
      ? this.prisma.$executeRaw`
          WITH bumped AS (
            UPDATE knowledge_sources
            SET embedding_generation = embedding_generation + 1
            WHERE workspace_id = ${workspaceId}::uuid AND id = ${sourceId}::uuid
            RETURNING id, workspace_id
          )
          UPDATE knowledge_chunks SET embedding = NULL
          WHERE source_id = ANY (SELECT id FROM bumped)
            AND workspace_id = ANY (SELECT workspace_id FROM bumped)`
      : this.prisma.$executeRaw`
          WITH bumped AS (
            UPDATE knowledge_sources
            SET embedding_generation = embedding_generation + 1
            WHERE workspace_id = ${workspaceId}::uuid
            RETURNING id, workspace_id
          )
          UPDATE knowledge_chunks SET embedding = NULL
          WHERE source_id = ANY (SELECT id FROM bumped)
            AND workspace_id = ANY (SELECT workspace_id FROM bumped)`;
  }

  /**
   * Validates that every id belongs to the workspace (and optionally the agent
   * or is workspace-scoped). Used by the agent generator / spec save paths.
   */
  async resolveReferencedSourceIds(
    workspaceId: string,
    agentId: string | null,
    sourceIds: string[],
  ): Promise<string[]> {
    if (sourceIds.length === 0) return [];
    const rows = await this.prisma.knowledgeSource.findMany({
      where: {
        id: { in: sourceIds },
        workspaceId,
        OR: agentId ? [{ agentId }, { agentId: null }] : [{ agentId: null }],
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Cosine-similarity search via pgvector. Falls back to JSON embed if pgvector
   * is unavailable or dimension does not match.
   */
  async pgvectorSearch(
    workspaceId: string,
    queryEmbedding: number[],
    topK = 5,
    agentId?: string | null,
  ) {
    const agentClause = agentId === undefined
      ? Prisma.empty
      : agentId === null
        ? Prisma.sql`AND ks.agent_id IS NULL`
        : Prisma.sql`AND (ks.agent_id = ${agentId}::uuid OR ks.agent_id IS NULL)`;
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;
    const chunks = await this.prisma.$queryRaw<RawKnowledgeChunk[]>`
      SELECT kc.id, kc.content, kc.source_id
      FROM knowledge_chunks kc
      JOIN knowledge_sources ks ON ks.id = kc.source_id
      WHERE ks.workspace_id = ${workspaceId}::uuid
        AND ks.status = 'ready'
        AND kc.embedding IS NOT NULL
        ${agentClause}
      ORDER BY kc.embedding <=> ${vectorLiteral}::vector
      LIMIT ${topK}
    `;
    return chunks;
  }

  private async lexicalSearch(
    workspaceId: string,
    query: string,
    topK: number,
    agentId?: string | null,
  ): Promise<RawKnowledgeChunk[]> {
    const agentClause = agentId === undefined
      ? Prisma.empty
      : agentId === null
        ? Prisma.sql`AND ks.agent_id IS NULL`
        : Prisma.sql`AND (ks.agent_id = ${agentId}::uuid OR ks.agent_id IS NULL)`;
    const likePattern = this.escapeLikePattern(query);
    const likeEscape = '\\';
    return this.prisma.$queryRaw<RawKnowledgeChunk[]>`
      SELECT kc.id, kc.content, kc.source_id
      FROM knowledge_chunks kc
      JOIN knowledge_sources ks ON ks.id = kc.source_id
      WHERE ks.workspace_id = ${workspaceId}::uuid
        AND ks.status = 'ready'
        ${agentClause}
        AND (
          kc.content ILIKE ${likePattern} ESCAPE ${likeEscape}
          OR to_tsvector('simple', kc.content) @@ websearch_to_tsquery('simple', ${query})
        )
      ORDER BY
        CASE WHEN kc.content ILIKE ${likePattern} ESCAPE ${likeEscape} THEN 0 ELSE 1 END,
        ts_rank_cd(to_tsvector('simple', kc.content), websearch_to_tsquery('simple', ${query})) DESC,
        kc.created_at DESC
      LIMIT ${topK}
    `;
  }

  /**
   * Cosine-similarity search over chunk embeddings. Pulls all chunks visible
   * to the (workspace, agent) pair into memory and ranks them. Replace with
   * pgvector + ANN index in Phase 10 hardening.
   */
  async search(
    workspaceId: string,
    query: string,
    opts: { agentId?: string | null; k?: number } = {},
  ): Promise<KnowledgeSearchHit[]> {
    const k = Math.min(Math.max(opts.k ?? 5, 1), 20);
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    let lexicalChunks: RawKnowledgeChunk[] = [];
    try {
      lexicalChunks = await this.lexicalSearch(workspaceId, trimmed, k, opts.agentId);
    } catch (err) {
      this.logger.warn(`lexical knowledge search failed: ${(err as Error).message}`);
    }

    let queryVec: number[];
    try {
      [queryVec] = await this.embedder.embed([trimmed]);
    } catch (err) {
      if (lexicalChunks.length > 0) return this.toSearchHits(lexicalChunks, new Map(lexicalChunks.map((c) => [c.id, 1])));
      throw err;
    }

    // Try pgvector path when embedder dim is 1536 (Azure Ada v2 default)
    if (this.embedder.dimensions === 1536) {
      try {
        const vectorChunks = await this.pgvectorSearch(workspaceId, queryVec, k, opts.agentId);
        const combined = this.dedupeChunks([...lexicalChunks, ...vectorChunks]).slice(0, k);
        if (combined.length > 0) {
          return this.toSearchHits(combined, new Map(combined.map((c) => [c.id, 1])));
        }
      } catch (err) {
        this.logger.warn(`pgvector search failed, falling back to JSON: ${(err as Error).message}`);
      }
    }

    // JSON embed fallback
    const where: Prisma.KnowledgeChunkWhereInput = {
      workspaceId,
      source: { status: 'ready' },
    };
    if (opts.agentId !== undefined) {
      where.OR = opts.agentId
        ? [{ agentId: opts.agentId }, { agentId: null }]
        : [{ agentId: null }];
    }

    const chunks = await this.prisma.knowledgeChunk.findMany({
      where,
      include: { source: true },
    });
    if (chunks.length === 0) {
      return lexicalChunks.length > 0
        ? this.toSearchHits(lexicalChunks, new Map(lexicalChunks.map((c) => [c.id, 1])))
        : [];
    }

    const scored = chunks
      .map((c) => {
        const emb = this.coerceVec((c as unknown as Record<string, Prisma.JsonValue | null>).embedding);
        if (!emb) return null;
        return {
          chunk: c,
          score: cosineSim(queryVec, emb),
        };
      })
      .filter((x): x is { chunk: (typeof chunks)[number]; score: number } => x !== null);

    scored.sort((a, b) => b.score - a.score);
    const jsonHits = scored.slice(0, k).map(({ chunk, score }) => ({
      id: chunk.id,
      content: chunk.content,
      source_id: chunk.sourceId,
      score: Number(score.toFixed(6)),
    }));
    const combined = this.dedupeChunks([
      ...lexicalChunks,
      ...jsonHits.map(({ score: _score, ...chunk }) => chunk),
    ]).slice(0, k);
    const scoreById = new Map<string, number>([
      ...lexicalChunks.map((c) => [c.id, 1] as const),
      ...jsonHits.map((c) => [c.id, c.score] as const),
    ]);
    return this.toSearchHits(combined, scoreById);
  }

  private async toSearchHits(
    chunks: RawKnowledgeChunk[],
    scoreById: Map<string, number>,
  ): Promise<KnowledgeSearchHit[]> {
    const rows = await this.prisma.knowledgeChunk.findMany({
      where: { id: { in: chunks.map((c) => c.id) } },
      include: {
        source: {
          select: { id: true, title: true, sourceType: true, agentId: true },
        },
      },
    });
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    return chunks.map((chunk) => {
      const row = rowsById.get(chunk.id);
      return {
        chunk_id: chunk.id,
        source_id: chunk.source_id,
        source_title: row?.source.title ?? '',
        source_type: (row?.source.sourceType ?? 'text') as KnowledgeSearchHit['source_type'],
        agent_id: row?.source.agentId ?? null,
        chunk_index: row?.chunkIndex ?? 0,
        content: chunk.content,
        score: scoreById.get(chunk.id) ?? 1,
      };
    });
  }

  private dedupeChunks(chunks: RawKnowledgeChunk[]): RawKnowledgeChunk[] {
    const seen = new Set<string>();
    const out: RawKnowledgeChunk[] = [];
    for (const chunk of chunks) {
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      out.push(chunk);
    }
    return out;
  }

  private escapeLikePattern(value: string): string {
    return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  }

  private async processSource(
    sourceId: string,
    workspaceId: string,
    organizationId: string,
    agentId: string | null,
    text: string,
  ): Promise<void> {
    await this.prisma.knowledgeSource.update({
      where: { id: sourceId },
      data: { status: 'processing' },
    });
    try {
      await this.prisma.knowledgeChunk.deleteMany({ where: { sourceId } });
      const chunks = splitIntoChunks(text, CHUNK_CHAR_SIZE, CHUNK_OVERLAP);
      if (chunks.length === 0) {
        await this.prisma.knowledgeSource.update({
          where: { id: sourceId },
          data: { status: 'ready' },
        });
        return;
      }

      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += MAX_EMBED_BATCH) {
        const batch = chunks.slice(i, i + MAX_EMBED_BATCH);
        const vecs = await this.embedder.embed(batch);
        embeddings.push(...vecs);
      }

      await this.prisma.$transaction(
        chunks.map((content, idx) => this.insertChunkWithVector({
          sourceId,
          workspaceId,
          organizationId,
          agentId,
          chunkIndex: idx,
          content,
          embedding: embeddings[idx],
        })),
      );

      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: 'ready' },
      });
    } catch (err) {
      this.logger.error(`Knowledge ingest failed for ${sourceId}: ${(err as Error).message}`);
      const existing = await this.prisma.knowledgeSource.findUnique({
        where: { id: sourceId },
        select: { metadata: true },
      });
      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: {
          status: 'failed',
          metadata: this.mergeMetadata(existing?.metadata ?? null, {
            error: (err as Error).message,
          }) as Prisma.InputJsonValue,
        },
      });
      throw new KnowledgeIngestFailedError((err as Error).message, { sourceId });
    }
  }

  private fileMetadata(
    input: UploadFileInput,
    parsed: { kind: string; bytes: number },
    storedFile: StoredKnowledgeFile,
  ): Record<string, unknown> {
    return {
      filename: input.filename ?? null,
      mime_type: input.mimeType ?? null,
      file_kind: parsed.kind,
      bytes: parsed.bytes,
      storage_provider: storedFile.provider,
      storage_bucket: storedFile.bucket,
      storage_path: storedFile.path,
      storage_public_url: storedFile.publicUrl ?? null,
    };
  }

  private storedFileFromMetadata(
    fileUrl: string | null,
    metadata: Prisma.JsonValue | null,
  ): StoredKnowledgeFile | null {
    if (!fileUrl || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const provider = metadata.storage_provider;
    const bucket = metadata.storage_bucket;
    const path = metadata.storage_path;
    const publicUrl = metadata.storage_public_url;
    if (
      (provider !== 'supabase' && provider !== 's3')
      || typeof bucket !== 'string'
      || typeof path !== 'string'
    ) {
      return null;
    }

    return {
      provider,
      bucket,
      path,
      fileUrl,
      publicUrl: typeof publicUrl === 'string' ? publicUrl : null,
    };
  }

  private insertChunkWithVector(input: {
    sourceId: string;
    workspaceId: string;
    organizationId: string;
    agentId: string | null;
    chunkIndex: number;
    content: string;
    embedding: number[] | undefined;
  }) {
    const vectorLiteral = `[${(input.embedding ?? []).join(',')}]`;
    const metadata = JSON.stringify({
      embedder: this.embedder.name,
      dimensions: this.embedder.dimensions,
    });
    const agentIdValue = input.agentId
      ? Prisma.sql`${input.agentId}::uuid`
      : Prisma.sql`NULL`;

    return this.prisma.$executeRaw`
      INSERT INTO knowledge_chunks (
        id,
        source_id,
        workspace_id,
        organization_id,
        agent_id,
        chunk_index,
        content,
        embedding,
        metadata,
        created_at
      )
      VALUES (
        ${randomUUID()}::uuid,
        ${input.sourceId}::uuid,
        ${input.workspaceId}::uuid,
        ${input.organizationId}::uuid,
        ${agentIdValue},
        ${input.chunkIndex},
        ${input.content},
        ${vectorLiteral}::vector,
        ${metadata}::jsonb,
        now()
      )
    `;
  }

  private mergeMetadata(
    existing: Prisma.JsonValue | null,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      return { ...(existing as Record<string, unknown>), ...patch };
    }
    return patch;
  }

  private coerceVec(value: Prisma.JsonValue | null): number[] | null {
    if (!Array.isArray(value)) return null;
    const out: number[] = [];
    for (const v of value) {
      if (typeof v !== 'number') return null;
      out.push(v);
    }
    return out;
  }

  private toSummary(
    r: {
      id: string;
      workspaceId: string;
      agentId: string | null;
      title: string;
      sourceType: string;
      status: string;
      fileUrl: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    chunkCount: number,
  ): KnowledgeSourceSummary {
    return {
      id: r.id,
      workspace_id: r.workspaceId,
      agent_id: r.agentId,
      title: r.title,
      source_type: r.sourceType as KnowledgeSourceSummary['source_type'],
      status: r.status as KnowledgeSourceSummary['status'],
      file_url: r.fileUrl,
      chunk_count: chunkCount,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }
}

export function splitIntoChunks(text: string, size: number, overlap: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= size) return [trimmed];
  const step = Math.max(size - overlap, 1);
  const out: string[] = [];
  for (let i = 0; i < trimmed.length; i += step) {
    const slice = trimmed.slice(i, i + size).trim();
    if (slice.length > 0) out.push(slice);
    if (i + size >= trimmed.length) break;
  }
  return out;
}

export function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}
