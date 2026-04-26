import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateContactDtoSchema,
  GrantConsentDtoSchema,
  OptOutContactDtoSchema,
  RevokeConsentDtoSchema,
  UpdateContactDtoSchema,
  type CreateContactDto,
  type GrantConsentDto,
  type OptOutContactDto,
  type RevokeConsentDto,
  type SessionUser,
  type UpdateContactDto,
} from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ComplianceService } from './compliance.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/contacts')
export class ContactsController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return { items: await this.compliance.listContacts(workspaceId) };
  }

  @Post()
  async upsert(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateContactDtoSchema)) dto: CreateContactDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.compliance.upsertContact(workspaceId, user.id, dto);
  }

  @Get(':contactId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('contactId') contactId: string,
  ) {
    return this.compliance.getContact(workspaceId, contactId);
  }

  @Patch(':contactId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(UpdateContactDtoSchema)) dto: UpdateContactDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.compliance.updateContact(workspaceId, contactId, user.id, dto);
  }

  @Post(':contactId/consent')
  async grantConsent(
    @Param('workspaceId') workspaceId: string,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(GrantConsentDtoSchema)) dto: GrantConsentDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.compliance.grantConsent(workspaceId, contactId, user.id, dto);
  }

  @Post(':contactId/consent/revoke')
  async revokeConsent(
    @Param('workspaceId') workspaceId: string,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(RevokeConsentDtoSchema)) dto: RevokeConsentDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.compliance.revokeConsent(workspaceId, contactId, user.id, dto);
  }

  @Post(':contactId/opt-out')
  async optOut(
    @Param('workspaceId') workspaceId: string,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(OptOutContactDtoSchema)) dto: OptOutContactDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.compliance.optOutContact(workspaceId, contactId, user.id, dto);
  }
}
