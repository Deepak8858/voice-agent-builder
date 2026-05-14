import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { env } from '../config/env';

interface ExportOptions {
  orgId?: string;
  from?: Date;
  to?: Date;
  action?: string;
  format: 'csv' | 'json';
}

interface SignedReport {
  url: string;
  expiresAt: Date;
  hash: string;
}

@Injectable()
export class AuditExportService {
  private readonly logger = new Logger(AuditExportService.name);
  private readonly SECRET = env.ENCRYPTION_KEY ?? 'dev-secret-key';

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async getAuditLogs(options: ExportOptions) {
    const where: Record<string, unknown> = {};
    if (options.orgId) where.organizationId = options.orgId;
    if (options.action) where.action = options.action;
    if (options.from || options.to) {
      where.createdAt = {};
      if (options.from) (where.createdAt as Record<string, Date>).gte = options.from;
      if (options.to) (where.createdAt as Record<string, Date>).lte = options.to;
    }

    const logs = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    if (options.format === 'csv') {
      const header = 'id,workspace_id,organization_id,actor_user_id,action,resource_type,resource_id,created_at\n';
      const rows = logs.map(l =>
        `${l.id},${l.workspaceId ?? ''},${l.organizationId ?? ''},${l.actorUserId ?? ''},${l.action},${l.resourceType},${l.resourceId ?? ''},${l.createdAt.toISOString()}`
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
    const hash = createHmac('sha256', this.SECRET).update(content).digest('hex');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72hr

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

    await this.email.send({
      to: auditorEmail,
      subject: 'Your compliance audit report is ready',
      html: `<p>Your audit report is ready. Download at: <a href="${url}">${url}</a></p><p>Expires in 72 hours.</p>`,
      text: `Download at: ${url}. Expires in 72 hours.`,
    }).catch(err => this.logger.error('Failed to send audit report email', err));

    return { url, expiresAt, hash };
  }
}