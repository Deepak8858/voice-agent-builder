import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { AuditExportService } from './audit-export.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';

@Controller()
export class AuditExportController {
  constructor(private readonly exportSvc: AuditExportService) {}

  // Org admin self-service
  @Get('v1/orgs/:orgId/audit-logs')
  async getOrgAuditLogs(
    @Param('orgId') orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('action') action?: string,
    @Query('format') format?: 'csv' | 'json',
  ) {
    return this.exportSvc.getAuditLogs({
      orgId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      action,
      format: format ?? 'json',
    });
  }

  // Internal admin full export
  @Get('admin/audit/export')
  @UseGuards(InternalAuthGuard)
  async adminExport(
    @Query('org_id') orgId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format?: 'csv' | 'json',
  ) {
    return this.exportSvc.getAuditLogs({
      orgId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      format: format ?? 'json',
    });
  }

  // Regulator signed URL
  @Post('admin/audit/report')
  @UseGuards(InternalAuthGuard)
  async generateReport(
    @Body() body: { orgId: string; from: string; to: string; auditor_email: string },
  ) {
    return this.exportSvc.generateSignedReport(
      body.orgId,
      new Date(body.from),
      new Date(body.to),
      body.auditor_email,
    );
  }
}