import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { WorkspaceCrmService } from './workspace-crm.service';

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
    @Body() body: { provider: string; credentials: Record<string, string>; config?: Record<string, unknown> },
  ) {
    return this.crm.create(workspaceId, body);
  }

  @Patch(':credentialId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('credentialId') credentialId: string,
    @Body() body: { credentials?: Record<string, string>; config?: Record<string, unknown>; status?: string },
  ) {
    return this.crm.update(workspaceId, credentialId, body);
  }

  @Delete(':credentialId')
  async delete(
    @Param('workspaceId') workspaceId: string,
    @Param('credentialId') credentialId: string,
  ) {
    await this.crm.delete(workspaceId, credentialId);
    return { success: true };
  }

  @Post(':credentialId/test')
  async test(
    @Param('workspaceId') workspaceId: string,
    @Param('credentialId') credentialId: string,
  ) {
    return this.crm.test(workspaceId, credentialId);
  }
}