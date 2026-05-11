import { Controller, Get, Post, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { PhoneNumbersService } from './phone-numbers.service';

@Controller('workspaces/:workspaceId/phone-numbers')
export class PhoneNumbersController {
  constructor(private readonly numbers: PhoneNumbersService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    const nums = await this.numbers.list(workspaceId);
    return { items: nums };
  }

  @Post('provision')
  async provision(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { area_code: string; agent_id?: string },
  ) {
    const number = await this.numbers.provision(workspaceId, body.area_code, body.agent_id);
    return { phone_number: number };
  }

  @Post('byo')
  async addByo(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { phone_number: string; twilio_sid?: string },
  ) {
    await this.numbers.addByo(workspaceId, body.phone_number, body.twilio_sid);
    return { success: true };
  }

  @Patch(':numberId/assign')
  async assign(
    @Param('workspaceId') workspaceId: string,
    @Param('numberId') numberId: string,
    @Body() body: { agent_id: string },
  ) {
    await this.numbers.assignToAgent(numberId, body.agent_id);
    return { success: true };
  }

  @Delete(':numberId')
  async release(
    @Param('workspaceId') workspaceId: string,
    @Param('numberId') numberId: string,
  ) {
    await this.numbers.release(numberId);
    return { success: true };
  }
}