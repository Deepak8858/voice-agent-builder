import { Body, Controller, Get, Inject, Param, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from '../auth/auth.service';
import { UnauthorizedError } from '../common/errors';
import { CurrentUser } from '../common/current-user.decorator';
import type { SessionUser } from '@voiceforge/shared';
import { WorkspacesService } from './workspaces.service';

const UpdateWorkspaceSchema = z.object({ name: z.string().min(1).max(120).optional() });
type UpdateWorkspaceDto = z.infer<typeof UpdateWorkspaceSchema>;

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly service: WorkspacesService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const user = await this.auth.getSessionUser(req);
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
