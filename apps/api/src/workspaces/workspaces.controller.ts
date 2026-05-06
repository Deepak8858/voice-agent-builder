import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UnauthorizedError } from '../common/errors';
import { CurrentUser } from '../common/current-user.decorator';
import type { SessionUser } from '@voiceforge/shared';
import { WorkspacesService } from './workspaces.service';

const UpdateWorkspaceSchema = z.object({ name: z.string().min(1).max(120).optional() });
type UpdateWorkspaceDto = z.infer<typeof UpdateWorkspaceSchema>;

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly service: WorkspacesService) {}

  @Get()
  async list(@CurrentUser() user: SessionUser | undefined) {
    if (!user) throw new UnauthorizedError();
    return { items: await this.service.listForUser(user.id) };
  }

  @UseGuards(WorkspaceGuard)
  @Get(':workspaceId')
  async get(@Param('workspaceId') workspaceId: string) {
    return this.service.get(workspaceId);
  }

  @UseGuards(WorkspaceGuard)
  @Patch(':workspaceId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateWorkspaceSchema)) dto: UpdateWorkspaceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.update(workspaceId, user.id, dto);
  }
}
