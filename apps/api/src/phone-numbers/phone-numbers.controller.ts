import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';
import { PhoneNumbersService } from './phone-numbers.service';
import { CurrentUser } from '../common/current-user.decorator';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  AddByoPhoneNumberDtoSchema,
  ProvisionPhoneNumberDtoSchema,
  type AddByoPhoneNumberDto,
  type ProvisionPhoneNumberDto,
} from './phone-numbers.schemas';

// Provisioning and releasing numbers spends money and reroutes live calls. The
// service layer scopes every query by workspace, but without this guard the
// workspace in the URL is simply whatever the caller typed.
@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/phone-numbers')
export class PhoneNumbersController {
  constructor(private readonly numbers: PhoneNumbersService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    const nums = await this.numbers.list(workspaceId);
    return { items: nums };
  }

  // Both bodies are validated at the boundary rather than trusted: `area_code`
  // is interpolated into a Twilio carrier-search URL, `phone_number` claims a
  // globally unique row that routes inbound calls, and `twilio_sid` is
  // interpolated into a Twilio API path on release. The DTO types are imported
  // from the schema module, never restated - a hand-written required-property
  // parameter cannot be satisfied by a zod-inferred type under the build
  // config's `strict: false`.
  // Every route below spends money or reroutes live calls, so all four are
  // owner/admin — matching the equivalent routes on `telephony.controller.ts`.
  // `WorkspaceGuard` alone admits any member, viewers included.
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('provision')
  async provision(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(ProvisionPhoneNumberDtoSchema)) body: ProvisionPhoneNumberDto,
  ) {
    const number = await this.numbers.provision(workspaceId, body.area_code, body.agent_id);
    return { phone_number: number };
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Post('byo')
  async addByo(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(AddByoPhoneNumberDtoSchema)) body: AddByoPhoneNumberDto,
  ) {
    await this.numbers.addByo(workspaceId, body.phone_number, body.twilio_sid);
    return { success: true };
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Patch(':numberId/assign')
  async assign(
    @Param('workspaceId') workspaceId: string,
    @Param('numberId') numberId: string,
    @Body() body: { agent_id: string },
    @CurrentUser() user: SessionUser | undefined,
  ) {
    await this.numbers.assignToAgent(workspaceId, numberId, body.agent_id, user?.id ?? null);
    return { success: true };
  }

  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  @Delete(':numberId')
  async release(
    @Param('workspaceId') workspaceId: string,
    @Param('numberId') numberId: string,
    @CurrentUser() user: SessionUser | undefined,
  ) {
    await this.numbers.release(workspaceId, numberId, user?.id ?? null);
    return { success: true };
  }
}