import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UnauthorizedError } from '../common/errors';
import { CurrentUser } from '../common/current-user.decorator';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
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

  // WorkspaceGuard only proves membership. Renaming a workspace changes what
  // every other member (and white-label branding) sees, so it is an admin
  // action; RoleGuard re-resolves the seat instead of trusting the session copy.
  @UseGuards(WorkspaceGuard, RoleGuard)
  @RequiredRole('owner', 'admin')
  @Patch(':workspaceId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateWorkspaceSchema)) dto: UpdateWorkspaceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.update(workspaceId, user.id, dto);
  }
}
