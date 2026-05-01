import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(EMBEDDING_PROVIDER_TOKEN) private readonly embedder: EmbeddingProvider,
    private readonly fileParser: FileParser,
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

    const created = await this.prisma.knowledgeSource.create({
      data: {
        workspaceId,
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
      await this.processSource(created.id, workspaceId, dto.agent_id ?? null, dto.content);
    } else if (dto.source_type === 'url' && dto.file_url) {
      // Best-effort inline fetch + parse + chunk + embed. We mark the source
      // as `processing`, perform the work, then `ready` or `failed`.
      try {
        const text = await this.fetchAndExtractUrl(dto.file_url);
        if (!text || text.trim().length === 0) {
          await this.prisma.knowledgeSource.update({
            where: { id: created.id },
            data: {
              status: 'failed',
              metadata: { error: 'No readable text at URL' } as Prisma.InputJsonValue,
            },
          });
        } else {
          await this.processSource(created.id, workspaceId, dto.agent_id ?? null, text);
        }
      } catch (err) {
        this.logger.warn(`URL ingest failed for ${dto.file_url}: ${(err as Error).message}`);
        await this.prisma.knowledgeSource.update({
          where: { id: created.id },
          data: {
            status: 'failed',
            metadata: { error: (err as Error).message } as Prisma.InputJsonValue,
          },
        });
      }
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

    const created = await this.prisma.knowledgeSource.create({
      data: {
        workspaceId,
        agentId: input.agentId ?? null,
        sourceType: 'file',
        title: input.title,
        fileUrl: null,
        content: parsed.text,
        status: 'pending',
        metadata: {
          filename: input.filename ?? null,
          mime_type: input.mimeType ?? null,
          file_kind: parsed.kind,
          bytes: parsed.bytes,
        } as Prisma.InputJsonValue,
        createdBy: actorUserId,
      },
    });

    await this.processSource(created.id, workspaceId, input.agentId ?? null, parsed.text);

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

    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { sourceId } });
      await tx.knowledgeSource.delete({ where: { id: sourceId } });
    });

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
   * Cosine-similarity search over chunk embeddings.
   *
   * Primary path: pgvector ANN index (HNSW) via raw SQL when embedder is
   * 1536-dim (matches column type). Falls back to in-memory cosine ranking
   * for low-dim mocks or if the raw query errors (e.g. extension not enabled).
   */
  async search(
    workspaceId: string,
    query: string,
    opts: { agentId?: string | null; k?: number } = {},
  ): Promise<KnowledgeSearchHit[]> {
    const k = Math.min(Math.max(opts.k ?? 5, 1), 20);
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const [queryVec] = await this.embedder.embed([trimmed]);

    if (this.embedder.dimensions === 1536) {
      try {
        const hits = await this.pgvectorSearch(workspaceId, queryVec, opts, k);
        if (hits.length > 0) return hits;
      } catch (err) {
        this.logger.warn(
          `pgvector search failed (${(err as Error).message}); falling back to in-memory.`,
        );
      }
    }
    return this.inMemorySearch(workspaceId, queryVec, opts, k);
  }

  private async pgvectorSearch(
    workspaceId: string,
    queryVec: number[],
    opts: { agentId?: string | null },
    k: number,
  ): Promise<KnowledgeSearchHit[]> {
    const literal = `[${queryVec.join(',')}]`;
    const agentClause =
      opts.agentId !== undefined
        ? opts.agentId
          ? Prisma.sql`AND (kc.agent_id = ${opts.agentId}::uuid OR kc.agent_id IS NULL)`
          : Prisma.sql`AND kc.agent_id IS NULL`
        : Prisma.sql``;

    const rows = await this.prisma.$queryRaw<
      Array<{
        chunk_id: string;
        source_id: string;
        source_title: string;
        source_type: string;
        agent_id: string | null;
        chunk_index: number;
        content: string;
        score: number;
      }>
    >`
      SELECT
        kc.id            AS chunk_id,
        kc.source_id     AS source_id,
        ks.title         AS source_title,
        ks.source_type   AS source_type,
        ks.agent_id      AS agent_id,
        kc.chunk_index   AS chunk_index,
        kc.content       AS content,
        1 - (kc.embedding_vector <=> ${literal}::vector) AS score
      FROM knowledge_chunks kc
      JOIN knowledge_sources ks ON ks.id = kc.source_id
      WHERE kc.workspace_id = ${workspaceId}::uuid
        AND ks.status = 'ready'
        AND kc.embedding_vector IS NOT NULL
        ${agentClause}
      ORDER BY kc.embedding_vector <=> ${literal}::vector
      LIMIT ${k}
    `;

    return rows.map((r) => ({
      chunk_id: r.chunk_id,
      source_id: r.source_id,
      source_title: r.source_title,
      source_type: r.source_type as KnowledgeSearchHit['source_type'],
      agent_id: r.agent_id,
      chunk_index: r.chunk_index,
      content: r.content,
      score: Number(Number(r.score).toFixed(6)),
    }));
  }

  private async inMemorySearch(
    workspaceId: string,
    queryVec: number[],
    opts: { agentId?: string | null },
    k: number,
  ): Promise<KnowledgeSearchHit[]> {
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
      include: {
        source: {
          select: { id: true, title: true, sourceType: true, agentId: true },
        },
      },
    });
    if (chunks.length === 0) return [];

    const scored = chunks
      .map((c) => {
        const emb = this.coerceVec(c.embedding);
        if (!emb) return null;
        return { chunk: c, score: cosineSim(queryVec, emb) };
      })
      .filter((x): x is { chunk: (typeof chunks)[number]; score: number } => x !== null);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ chunk, score }) => ({
      chunk_id: chunk.id,
      source_id: chunk.sourceId,
      source_title: chunk.source.title,
      source_type: chunk.source.sourceType as KnowledgeSearchHit['source_type'],
      agent_id: chunk.source.agentId,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      score: Number(score.toFixed(6)),
    }));
  }

  private async processSource(
    sourceId: string,
    workspaceId: string,
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

      await this.prisma.knowledgeChunk.createMany({
        data: chunks.map((content, idx) => ({
          sourceId,
          workspaceId,
          agentId,
          chunkIndex: idx,
          content,
          embedding: embeddings[idx] as unknown as Prisma.InputJsonValue,
          metadata: {
            embedder: this.embedder.name,
            dimensions: this.embedder.dimensions,
          } as Prisma.InputJsonValue,
        })),
      });

      // Mirror embeddings into the pgvector column so HNSW search can use
      // the same rows. Only write when the embedder dimensions match the
      // column type (1536); the mock 64-dim embedder uses Json-only path.
      if (this.embedder.dimensions === 1536) {
        try {
          const newRows = await this.prisma.knowledgeChunk.findMany({
            where: { sourceId },
            select: { id: true, chunkIndex: true },
            orderBy: { chunkIndex: 'asc' },
          });
          for (const row of newRows) {
            const vec = embeddings[row.chunkIndex];
            if (!vec) continue;
            const literal = `[${vec.join(',')}]`;
            await this.prisma.$executeRaw`
              UPDATE knowledge_chunks
              SET embedding_vector = ${literal}::vector
              WHERE id = ${row.id}::uuid
            `;
          }
        } catch (err) {
          this.logger.warn(
            `pgvector backfill failed (${(err as Error).message}); rows will use Json-only fallback.`,
          );
        }
      }

      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: 'ready' },
      });
    } catch (err) {
      this.logger.error(`Knowledge ingest failed for ${sourceId}: ${(err as Error).message}`);
      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: {
          status: 'failed',
          metadata: { error: (err as Error).message } as Prisma.InputJsonValue,
        },
      });
      throw new KnowledgeIngestFailedError((err as Error).message, { sourceId });
    }
  }

  /**
   * Fetch a URL and extract human-readable text. Uses cheerio to strip script
   * / style / nav noise. Hard-caps fetched body at ~5MB; aborts after 10s.
   */
  private async fetchAndExtractUrl(rawUrl: string): Promise<string> {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Unsupported URL protocol: ${url.protocol}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'user-agent': 'VoiceForge-KnowledgeBot/1.0 (+https://voiceforge.ai)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 5 * 1024 * 1024) {
        throw new Error('Response exceeds 5MB cap');
      }
      const body = new TextDecoder('utf-8', { fatal: false }).decode(buf);

      if (contentType.includes('text/html') || /^\s*</.test(body)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cheerio = require('cheerio') as typeof import('cheerio');
        const $ = cheerio.load(body);
        $('script, style, noscript, iframe, nav, footer, header, aside').remove();
        const main = $('main, article').first();
        const text = (main.length ? main.text() : $('body').text()).replace(/\s+/g, ' ').trim();
        return text;
      }
      return body.replace(/\s+/g, ' ').trim();
    } finally {
      clearTimeout(timeout);
    }
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
