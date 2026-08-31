import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ValidationError } from '../common/errors';
import { env } from '../config/env';

interface ExportOptions {
  /**
   * Required: an export with no organization reads every tenant's audit log.
   * `admin/audit/export` used to take `org_id` as an optional query param, so
   * omitting it produced `where: {}` — a 10k-row cross-tenant dump.
   */
  orgId: string;
  from?: Date;
  to?: Date;
  action?: string;
  format: 'csv' | 'json';
}

/**
 * Exactly the columns the CSV header below declares. The rows also carry
 * `metadata` (free-form JSON written by every call site), `ipAddress` and
 * `userAgent`; the JSON branch returned whole rows, so it disclosed strictly
 * more than the documented CSV contract. Projecting both branches through this
 * list keeps them identical — widening the export means adding a CSV column in
 * the same edit.
 */
const EXPORT_FIELDS = {
  id: true,
  workspaceId: true,
  organizationId: true,
  actorUserId: true,
  action: true,
  resourceType: true,
  resourceId: true,
  createdAt: true,
} as const;

interface SignedReport {
  reportId: string;
  expiresAt: Date;
  hash: string;
}

/**
 * Escapes a value for CSV output per RFC 4180.
 * Fields containing commas, quotes, or newlines are wrapped in double-quotes
 * with embedded double-quotes escaped as double-double-quotes.
 */
function escapeCsvField(val: string | null | undefined): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

@Injectable()
export class AuditExportService {
  private static readonly REPORT_EXPIRY_MS = 72 * 60 * 60 * 1000;
  private readonly HMAC_SECRET = env.ENCRYPTION_KEY ?? 'dev-secret-key';

  constructor(
    private readonly prisma: PrismaService,
    // Unused until the audit report download route exists; the auditor
    // notification is sent from generateSignedReport again at that point.
    private readonly email: EmailService,
  ) {}

  async getAuditLogs(options: ExportOptions) {
    // Both export routes funnel through here, so this is where the all-tenant
    // read is made unreachable rather than merely guarded at each caller. The
    // type already forbids omitting it; this catches an untyped caller and the
    // `?org_id=` blank that would otherwise scope on the empty string.
    if (!options.orgId?.trim()) {
      throw new ValidationError('An audit export must name an organization.');
    }

    const where: Prisma.AuditLogWhereInput = { organizationId: options.orgId };
    if (options.action) where.action = options.action;
    if (options.from || options.to) {
      where.createdAt = {};
      if (options.from) where.createdAt.gte = options.from;
      if (options.to) where.createdAt.lte = options.to;
    }

    const logs = await this.prisma.auditLog.findMany({
      where,
      select: EXPORT_FIELDS,
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    if (options.format === 'csv') {
      const header = 'id,workspace_id,organization_id,actor_user_id,action,resource_type,resource_id,created_at\n';
      const rows = logs.map(l =>
        [
          escapeCsvField(l.id),
          escapeCsvField(l.workspaceId),
          escapeCsvField(l.organizationId),
          escapeCsvField(l.actorUserId),
          escapeCsvField(l.action),
          escapeCsvField(l.resourceType),
          escapeCsvField(l.resourceId),
          escapeCsvField(l.createdAt.toISOString()),
        ].join(',')
      ).join('\n');
      return header + rows;
    }

    return logs;
  }

  /**
   * Attestation record for an operator-requested compliance report. Reads
   * through `getAuditLogs`, so the report cannot disclose more than the
   * documented export does: one projection (EXPORT_FIELDS — it used to read
   * whole rows and JSON.stringify free-form `metadata`, `ipAddress` and
   * `userAgent` into a document meant for an external auditor), one 10k cap,
   * one organization check.
   */
  async generateSignedReport(orgId: string, from: Date, to: Date, auditorEmail: string): Promise<SignedReport> {
    // Hashed over exactly the bytes stored. `content` was truncated to 10k
    // chars while `contentHash` covered the untruncated JSON, so every report
    // past that size carried an attestation that could never be re-verified
    // against the row holding it. Eight narrow fields capped at 10k rows are
    // small enough to keep whole, which is the half of that trade that keeps
    // the signature meaningful.
    const content = JSON.stringify(await this.getAuditLogs({ orgId, from, to, format: 'json' }));
    const hash = createHmac('sha256', this.HMAC_SECRET).update(content).digest('hex');
    const expiresAt = new Date(Date.now() + AuditExportService.REPORT_EXPIRY_MS);

    // No download link is issued. `/api/audit/report/:token` has never been
    // served, so the auditor email promised an outside party a guaranteed 404,
    // and serving it would mean a new unauthenticated endpoint. The row keeps
    // the digest-shaped `token` an authenticated download route will need —
    // look the row up by sha256 of the token presented, never store the token
    // itself — so that route, and the auditor email carrying its URL, land
    // without a migration. Until then the raw token is discarded: the report
    // content lives in the row for the operator who requested it.
    const report = await this.prisma.auditReport.create({
      data: {
        token: createHash('sha256').update(randomBytes(32)).digest('hex'),
        organizationId: orgId,
        fromDate: from,
        toDate: to,
        auditorEmail,
        contentHash: hash,
        content,
        expiresAt,
      },
    });

    return { reportId: report.id, expiresAt, hash };
  }
}
