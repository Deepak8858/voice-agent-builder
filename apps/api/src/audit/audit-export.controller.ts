import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuditExportService } from './audit-export.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { OrganizationGuard } from '../common/organization.guard';
import { RequiredOrgRole } from '../common/decorators/required-org-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * `org_id` is the export's only scope. `.trim()` before `.min(1)` so neither an
 * absent param nor `?org_id=%20` reaches the service as a falsy-but-present
 * organization.
 */
const OrgIdQuerySchema = z.string().trim().min(1);

@Controller()
export class AuditExportController {
  constructor(private readonly exportSvc: AuditExportService) {}

  /**
   * Org admin self-service audit log read.
   *
   * This route had no guard at all — only the sibling `admin/*` routes below
   * carried `InternalAuthGuard`. The global `InternalAuthGuard` authenticated
   * the caller but nothing authorized them against `:orgId`, which flows
   * straight into `where.organizationId`, so any authenticated user could read
   * any organization's full audit log (10k rows: actor ids, actions, resource
   * ids). `OrganizationGuard` verifies the caller actually belongs to `:orgId`.
   *
   * Belonging is not enough on its own, though, and that was left open when the
   * tenant hole was closed: membership is per-workspace, so any `viewer` in any
   * workspace of the org could read the org's entire audit log — actor ids,
   * actions and resource ids across workspaces they are not a member of. Reading
   * an audit log is an administrative capability, so the route is narrowed to an
   * org-level seat with `@RequiredOrgRole`, which OrganizationGuard enforces
   * against the same derivation (any workspace of the org, plus outright
   * ownership). `@RequiredRole` + `RoleGuard` cannot be used here: RoleGuard
   * refuses every `:orgId` route by design.
   */
  @Get('v1/orgs/:orgId/audit-logs')
  @UseGuards(OrganizationGuard)
  @RequiredOrgRole('owner', 'admin')
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

  // Internal admin full export. `@UseGuards(InternalAuthGuard)` only
  // authenticates — the guard is global anyway — and the Next.js proxy
  // attaches the internal key to any path a signed-in user requests, so
  // without @InternalOnly() any tenant user could export every tenant's
  // audit log. @InternalOnly() refuses user-carrying requests, leaving the
  // route reachable only by an operator holding the bare key.
  //
  // `org_id` was optional, and the service only added `where.organizationId`
  // when it was set, so `GET admin/audit/export` with no `org_id` returned
  // 10k rows across every tenant. It is now required at both ends.
  @InternalOnly()
  @Get('admin/audit/export')
  @UseGuards(InternalAuthGuard)
  async adminExport(
    @Query('org_id', new ZodValidationPipe(OrgIdQuerySchema)) orgId: string,
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

  // Regulator signed URL. Same reasoning as the export above: operator-only,
  // so user context must be refused, not just authenticated.
  @InternalOnly()
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