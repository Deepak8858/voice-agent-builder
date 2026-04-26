import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AddDncDtoSchema,
  ComplianceCheckRequestDtoSchema,
  type AddDncDto,
  type ComplianceCheckRequestDto,
  type SessionUser,
} from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ComplianceService } from './compliance.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Post('check')
  async check(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(ComplianceCheckRequestDtoSchema))
    dto: ComplianceCheckRequestDto,
  ) {
    return this.compliance.check({
      workspaceId,
      agentId: dto.agent_id,
      direction: dto.direction,
      toNumber: dto.to_number ?? null,
      contactId: dto.contact_id ?? null,
      purpose: dto.purpose ?? null,
    });
  }

  @Get('dnc')
  async listDnc(@Param('workspaceId') workspaceId: string) {
    return { items: await this.compliance.listDnc(workspaceId) };
  }

  @Post('dnc')
  async addDnc(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(AddDncDtoSchema)) dto: AddDncDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.compliance.addDnc(workspaceId, user.id, dto);
  }

  @Delete('dnc/:phone')
  @HttpCode(204)
  async removeDnc(
    @Param('workspaceId') workspaceId: string,
    @Param('phone') phone: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.compliance.removeDnc(workspaceId, phone, user.id);
  }
}
