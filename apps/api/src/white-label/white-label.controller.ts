import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AcceptClientInviteDtoSchema,
  CreateClientInviteDtoSchema,
  CreateClientWorkspaceDtoSchema,
  UpdateWhiteLabelSettingsDtoSchema,
  type AcceptClientInviteDto,
  type CreateClientInviteDto,
  type CreateClientWorkspaceDto,
  type SessionUser,
  type UpdateWhiteLabelSettingsDto,
} from '@voiceforge/shared';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../common/current-user.decorator';
import { UnauthorizedError } from '../common/errors';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { WhiteLabelService } from './white-label.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/white-label')
export class WhiteLabelController {
  constructor(private readonly service: WhiteLabelService) {}

  @Get()
  async get(@Param('workspaceId') workspaceId: string) {
    return this.service.getSettings(workspaceId);
  }

  @Patch()
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateWhiteLabelSettingsDtoSchema))
    dto: UpdateWhiteLabelSettingsDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.updateSettings(workspaceId, user.id, dto);
  }
}

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/clients')
export class ClientWorkspacesController {
  constructor(private readonly service: WhiteLabelService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return { items: await this.service.listClients(workspaceId) };
  }

  @Get('agents')
  async listAgents(@Param('workspaceId') workspaceId: string) {
    return { items: await this.service.listAgencyAgents(workspaceId) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateClientWorkspaceDtoSchema))
    dto: CreateClientWorkspaceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.createClient(workspaceId, user.id, dto);
  }

  @Get(':clientWorkspaceId/usage')
  async usage(
    @Param('workspaceId') workspaceId: string,
    @Param('clientWorkspaceId') clientWorkspaceId: string,
  ) {
    return this.service.clientUsage(workspaceId, clientWorkspaceId);
  }
}

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/invites')
export class ClientInvitesController {
  constructor(private readonly service: WhiteLabelService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return { items: await this.service.listInvites(workspaceId) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateClientInviteDtoSchema))
    dto: CreateClientInviteDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.createInvite(workspaceId, user.id, dto);
  }

  @Delete(':inviteId')
  async revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('inviteId') inviteId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.revokeInvite(workspaceId, user.id, inviteId);
  }
}

/**
 * Standalone (no workspace guard) — only requires auth. The token itself
 * is the access credential.
 */
@Controller('invites/accept')
export class InviteAcceptController {
  constructor(
    private readonly service: WhiteLabelService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @HttpCode(200)
  async accept(
    @Req() req: Request,
    @Body(new ZodValidationPipe(AcceptClientInviteDtoSchema)) dto: AcceptClientInviteDto,
  ) {
    const user = await this.auth.getSessionUser(req);
    if (!user) throw new UnauthorizedError();
    return this.service.acceptInvite(user.id, dto.token);
  }
}
