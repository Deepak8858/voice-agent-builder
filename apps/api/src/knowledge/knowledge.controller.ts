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
import { KnowledgeService } from './knowledge.service';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

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
}
