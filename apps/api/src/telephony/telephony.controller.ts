import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  AssignPhoneNumberAgentDtoSchema,
  CreateTelephonyConnectionDtoSchema,
  ImportPhoneNumbersDtoSchema,
  ManualPhoneNumberDtoSchema,
  StartTelephonyOutboundCallDtoSchema,
  type AssignPhoneNumberAgentDto,
  type CreateTelephonyConnectionDto,
  type ImportPhoneNumbersDto,
  type ManualPhoneNumberDto,
  type SessionUser,
  type StartTelephonyOutboundCallDto,
} from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TelephonyService } from './telephony.service';

// Reads stay open to every member — connection rows are returned with the
// provider account id masked and phone-number rows carry no credentials.
// Every mutation touches tenant provider credentials, live routing, or spends
// call minutes, so all of them are owner/admin.
@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/telephony')
export class TelephonyController {
  constructor(private readonly telephony: TelephonyService) {}

  @Get('providers')
  providers() {
    return this.telephony.providers();
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('connections')
  createConnection(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(CreateTelephonyConnectionDtoSchema)) dto: CreateTelephonyConnectionDto,
  ) {
    return this.telephony.createConnection(workspaceId, user.id, dto);
  }

  @Get('connections')
  listConnections(@Param('workspaceId') workspaceId: string) {
    return this.telephony.listConnections(workspaceId);
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('connections/:connectionId/sync-numbers')
  syncNumbers(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.telephony.syncNumbers(workspaceId, connectionId, user.id);
  }

  @Get('phone-numbers')
  listPhoneNumbers(@Param('workspaceId') workspaceId: string) {
    return this.telephony.listPhoneNumbers(workspaceId);
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('phone-numbers/import')
  importNumbers(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(ImportPhoneNumbersDtoSchema)) dto: ImportPhoneNumbersDto,
  ) {
    return this.telephony.importNumbers(workspaceId, user.id, dto);
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('phone-numbers/manual')
  manualNumber(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(ManualPhoneNumberDtoSchema)) dto: ManualPhoneNumberDto,
  ) {
    return this.telephony.createManualNumber(workspaceId, user.id, dto);
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('phone-numbers/:numberId/assign-agent')
  assignAgent(
    @Param('workspaceId') workspaceId: string,
    @Param('numberId') numberId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(AssignPhoneNumberAgentDtoSchema)) dto: AssignPhoneNumberAgentDto,
  ) {
    return this.telephony.assignAgent(workspaceId, numberId, user.id, dto);
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('phone-numbers/:numberId/configure-livekit')
  configureLiveKit(
    @Param('workspaceId') workspaceId: string,
    @Param('numberId') numberId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.telephony.configureLiveKit(workspaceId, numberId, user.id);
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Delete('phone-numbers/:numberId')
  disconnect(
    @Param('workspaceId') workspaceId: string,
    @Param('numberId') numberId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.telephony.disconnectNumber(workspaceId, numberId, user.id);
  }

  @UseGuards(RoleGuard)
  @RequiredRole(['owner', 'admin'], { fresh: true })
  @Post('outbound-calls')
  startOutbound(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(StartTelephonyOutboundCallDtoSchema)) dto: StartTelephonyOutboundCallDto,
  ) {
    return this.telephony.startOutboundCall(workspaceId, user.id, dto);
  }
}
