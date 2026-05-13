import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';

@Controller('admin')
@UseGuards(InternalAuthGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('usage/overview')
  async getOrgUsageOverview() {
    return this.adminService.getOrgUsageOverview();
  }

  @Get('orgs/:id/usage')
  async getOrgUsageDetail(
    @Param('id') orgId: string,
    @Query('period') period?: string,
  ) {
    return this.adminService.getOrgUsageDetail(orgId, period);
  }

  @Get('orgs/:id/agents/usage')
  async getOrgAgentUsage(
    @Param('id') orgId: string,
    @Query('period') period: string,
  ) {
    return this.adminService.getOrgAgentUsage(orgId, period);
  }
}