import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type {
  CreateWorkspaceCrmCredentialDto,
  UpdateWorkspaceCrmCredentialDto,
} from './workspace-crm.schemas';
import {
  CreateWorkspaceCrmCredentialDtoSchema,
  UpdateWorkspaceCrmCredentialDtoSchema,
} from './workspace-crm.schemas';
import type { SessionUser } from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { WorkspaceCrmService } from './workspace-crm.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/crm-credentials')
export class WorkspaceCrmController {
  constructor(private readonly crm: WorkspaceCrmService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    const creds = await this.crm.list(workspaceId);
    return { items: creds };
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateWorkspaceCrmCredentialDtoSchema)) body: CreateWorkspaceCrmCredentialDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.crm.create(workspaceId, user.id, body);
  }

  @Patch(':credentialId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('credentialId') credentialId: string,
    @Body(new ZodValidationPipe(UpdateWorkspaceCrmCredentialDtoSchema)) body: UpdateWorkspaceCrmCredentialDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.crm.update(workspaceId, credentialId, user.id, body);
  }

  @Delete(':credentialId')
  async delete(
    @Param('workspaceId') workspaceId: string,
    @Param('credentialId') credentialId: string,
    @CurrentUser() user: SessionUser,
  ) {
    await this.crm.delete(workspaceId, credentialId, user.id);
    return { success: true };
  }

  @Post(':credentialId/test')
  async test(
    @Param('workspaceId') workspaceId: string,
    @Param('credentialId') credentialId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.crm.test(workspaceId, credentialId, user.id);
  }
}
