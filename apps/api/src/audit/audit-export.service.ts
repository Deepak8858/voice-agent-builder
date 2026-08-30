import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
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
  url: string;
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
  private readonly logger = new Logger(AuditExportService.name);
  private static readonly REPORT_EXPIRY_MS = 72 * 60 * 60 * 1000;
  private readonly HMAC_SECRET = env.ENCRYPTION_KEY ?? 'dev-secret-key';

  constructor(
    private readonly prisma: PrismaService,
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

  async generateSignedReport(orgId: string, from: Date, to: Date, auditorEmail: string): Promise<SignedReport> {
    const logs = await this.prisma.auditLog.findMany({
      where: { organizationId: orgId, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'desc' },
    });

    const content = JSON.stringify(logs);
    const hash = createHmac('sha256', this.HMAC_SECRET).update(content).digest('hex');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + AuditExportService.REPORT_EXPIRY_MS);

    await this.prisma.auditReport.create({
      data: {
        token,
        organizationId: orgId,
        fromDate: from,
        toDate: to,
        auditorEmail,
        contentHash: hash,
        content: content.slice(0, 10000),
        expiresAt,
      },
    });

    const url = `${env.WEB_BASE_URL}/api/audit/report/${token}`;
    const expiryHours = String(AuditExportService.REPORT_EXPIRY_MS / (60 * 60 * 1000));

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('Must be https');
    } catch {
      this.logger.error('Invalid WEB_BASE_URL, cannot send audit report email');
      return { url, expiresAt, hash };
    }

    await this.email.send({
      to: auditorEmail,
      subject: 'Your compliance audit report is ready',
      html: `<p>Your audit report is ready. Download at: <a href="${url}">${url}</a></p><p>Expires in ${expiryHours} hours.</p>`,
      text: `Download at: ${url}. Expires in ${expiryHours} hours.`,
    }).catch(err => this.logger.error('Failed to send audit report email', err));

    return { url, expiresAt, hash };
  }
}