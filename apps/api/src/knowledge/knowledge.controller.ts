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
import { CurrentUser } from '../common/current-user.decorator';
import { KnowledgeFileInvalidError } from '../common/errors';
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
  ) {}

  @Get('knowledge-sources')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(KnowledgeSourceListQuerySchema))
    query: KnowledgeSourceListQuery,
  ) {
    return { items: await this.knowledge.list(workspaceId, query) };
  }

  @Post('knowledge-sources')
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateKnowledgeSourceDtoSchema))
    dto: CreateKnowledgeSourceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.knowledge.create(workspaceId, user.id, dto);
  }

  @Post('knowledge-sources/upload')
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

  @Get('knowledge-sources/search')
  async search(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(KnowledgeSearchQuerySchema))
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
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('sourceId') sourceId: string,
    @Body(new ZodValidationPipe(UpdateKnowledgeSourceDtoSchema))
    dto: UpdateKnowledgeSourceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.knowledge.update(workspaceId, sourceId, user.id, dto);
  }

  @Delete('knowledge-sources/:sourceId')
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
   * Enqueue a background job to regenerate embeddings for all chunks under
   * this source. Falls back to reindexing the full source if embedding vector
   * is null. Idempotent — safe to call multiple times.
   */
  @Post('knowledge-sources/:sourceId/reindex')
  @HttpCode(202)
  async reindex(
    @Param('workspaceId') _workspaceId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() _user: SessionUser,
  ): Promise<{ jobId: string; message: string }> {
    await this.queue.enqueue(EMBEDDINGS_QUEUE, 'generate-embeddings', {
      sourceId,
      force: false,
    });
    return {
      jobId: sourceId,
      message: `Reindex job queued for source ${sourceId}. Embeddings will be regenerated for any chunk with a null vector.`,
    };
  }

  /**
   * Enqueue a full backfill: regenerate embeddings for ALL chunks across the
   * entire workspace, including chunks that already have a vector.
   * Admin use only.
   */
  @Post('knowledge-sources/backfill')
  @HttpCode(202)
  async backfill(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() _user: SessionUser,
  ): Promise<{ jobId: string; message: string }> {
    // Mark all existing embeddings as null so the worker processes everything.
    await this.knowledge.clearEmbeddings(workspaceId);
    await this.queue.enqueue(EMBEDDINGS_QUEUE, 'generate-embeddings', {
      force: false,
    });
    return {
      jobId: `backfill-${workspaceId}`,
      message: `Backfill job queued. All chunks in workspace ${workspaceId} will have their embeddings regenerated where null.`,
    };
  }
}
