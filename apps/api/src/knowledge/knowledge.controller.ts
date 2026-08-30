import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CreateKnowledgeSourceDtoSchema,
  KnowledgeSearchQuerySchema,
  KnowledgeSourceListQuerySchema,
  KnowledgeUploadFormSchema,
  UpdateKnowledgeSourceDtoSchema,
  type CreateKnowledgeSourceDto,
  type KnowledgeSearchQuery,
  type KnowledgeSourceListQuery,
  type KnowledgeUploadForm,
  type SessionUser,
  type UpdateKnowledgeSourceDto,
} from '@voiceforge/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/current-user.decorator';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { KnowledgeFileInvalidError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { QueueService } from '../queue/queue.service';
import { EMBEDDINGS_QUEUE } from '../workers/embeddings.worker';
import { KnowledgeService } from './knowledge.service';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId')
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  @Get('knowledge-sources')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(KnowledgeSourceListQuerySchema))
    query: KnowledgeSourceListQuery,
  ) {
    return { items: await this.knowledge.list(workspaceId, query) };
  }

  // Knowledge mutations are content authoring, so editors are admitted, exactly
  // as in agents.controller.ts; the destructive routes at the bottom of the file
  // are narrower. Bound per-method because a class-level RoleGuard would fail
  // closed on the ungated GETs and on the read-shaped search.
  @Post('knowledge-sources')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateKnowledgeSourceDtoSchema))
    dto: CreateKnowledgeSourceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.knowledge.create(workspaceId, user.id, dto);
  }

  @Post('knowledge-sources/upload')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @Param('workspaceId') workspaceId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() rawBody: Record<string, unknown>,
    @CurrentUser() user: SessionUser,
  ) {
    if (!file) {
      throw new KnowledgeFileInvalidError('No file provided. Use multipart field "file".');
    }
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeName || safeName.length > 255) {
      throw new KnowledgeFileInvalidError('Invalid filename.');
    }
    // Validate mime type against allow-list
    const allowedMimes = ['application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json'];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new KnowledgeFileInvalidError(`Unsupported file type: ${file.mimetype}`);
    }
    const form: KnowledgeUploadForm = KnowledgeUploadFormSchema.parse({
      title: rawBody.title,
      agent_id: rawBody.agent_id === '' ? null : rawBody.agent_id,
    });
    return this.knowledge.uploadFile(workspaceId, user.id, {
      buffer: file.buffer,
      mimeType: file.mimetype,
      filename: safeName,
      title: form.title,
      agentId: form.agent_id ?? null,
    });
  }

  @Post('knowledge-sources/search')
  async search(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(KnowledgeSearchQuerySchema))
    query: KnowledgeSearchQuery,
  ) {
    const hits = await this.knowledge.search(workspaceId, query.query, {
      agentId: query.agent_id ?? undefined,
      k: query.k,
    });
    return { query: query.query, hits };
  }

  @Get('knowledge-sources/:sourceId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('sourceId') sourceId: string,
  ) {
    return this.knowledge.get(workspaceId, sourceId);
  }

  @Patch('knowledge-sources/:sourceId')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin', 'editor')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('sourceId') sourceId: string,
    @Body(new ZodValidationPipe(UpdateKnowledgeSourceDtoSchema))
    dto: UpdateKnowledgeSourceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.knowledge.update(workspaceId, sourceId, user.id, dto);
  }

  // Destroys persisted content, so it stops at admin and reads the membership
  // row fresh: a just-demoted admin must not delete a source through the 300s
  // workspace-access cache.
  @Delete('knowledge-sources/:sourceId')
  @UseGuards(RoleGuard)
  @RequiredRole(['owner', 'admin'], { fresh: true })
  @HttpCode(204)
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.knowledge.remove(workspaceId, sourceId, user.id);
  }

  @Get('agents/:agentId/knowledge-sources')
  async listForAgent(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
  ) {
    return { items: await this.knowledge.listForAgent(workspaceId, agentId) };
  }

  /**
   * Re-embed every chunk under this source. Idempotent — safe to call multiple
   * times.
   */
  @Post('knowledge-sources/:sourceId/reindex')
  @UseGuards(RoleGuard)
  @RequiredRole(['owner', 'admin'], { fresh: true })
  @HttpCode(202)
  async reindex(
    @Param('workspaceId') workspaceId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ jobId: string; message: string }> {
    // `get` first: it is what proves the source belongs to this workspace, and
    // clearEmbeddings must not run on someone else's source.
    await this.knowledge.get(workspaceId, sourceId);
    // Clearing is not optional. The worker selects only chunks whose vector IS
    // NULL, and ingest always writes a vector, so without this the job would
    // select zero rows and reindex would return 202 having done nothing.
    const { cleared, generations } = await this.knowledge.clearEmbeddings(workspaceId, sourceId);
    // The audit write is in `finally` so a failed enqueue still leaves a record:
    // the vectors are already gone at this point, which is the state an operator
    // most needs to be able to trace back to an actor.
    let enqueued = false;
    try {
      await this.queue.enqueue(EMBEDDINGS_QUEUE, 'generate-embeddings', {
        workspaceId,
        sourceId,
        // The generation the clear above just produced. Without it the worker
        // adopts whatever it reads on its first batch, which may already be a
        // later reset's number — and it would then keep writing vectors that
        // reset superseded.
        generation: generations[sourceId],
      });
      enqueued = true;
    } finally {
      await this.audit.log({
        workspaceId,
        actorUserId: user.id,
        action: 'knowledge_source.reindex',
        resourceType: 'knowledge_source',
        resourceId: sourceId,
        metadata: { scope: 'source', cleared_chunks: cleared, enqueued },
      });
    }
    return {
      jobId: sourceId,
      message: `Reindex job queued for source ${sourceId}. Every chunk under it had its vector cleared and will be re-embedded.`,
    };
  }

  /**
   * Enqueue a full backfill for THIS workspace only: clear every vector, then
   * let the worker re-embed them. Admin use only, and enforced as such.
   */
  @Post('knowledge-sources/backfill')
  @UseGuards(RoleGuard)
  @RequiredRole(['owner', 'admin'], { fresh: true })
  @HttpCode(202)
  async backfill(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ jobId: string; message: string }> {
    // Mark all existing embeddings as null so the worker — which only embeds
    // null vectors — picks up the whole workspace.
    const { cleared, generations } = await this.knowledge.clearEmbeddings(workspaceId);
    let enqueued = false;
    try {
      // The per-source map lets the worker refuse each source it no longer
      // owns immediately, instead of discovering it one embed pass late via
      // its snapshot fallback.
      await this.queue.enqueue(EMBEDDINGS_QUEUE, 'generate-embeddings', {
        workspaceId,
        generations,
      });
      enqueued = true;
    } finally {
      await this.audit.log({
        workspaceId,
        actorUserId: user.id,
        action: 'knowledge_source.backfill',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { scope: 'workspace', cleared_chunks: cleared, enqueued },
      });
    }
    return {
      jobId: `backfill-${workspaceId}`,
      message: `Backfill job queued. Every chunk in workspace ${workspaceId} had its vector cleared and will be re-embedded.`,
    };
  }
}
