import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { PipeTransform } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { ValidationError } from '../common/errors';
import { AuditExportController } from './audit-export.controller';
import { AuditExportService } from './audit-export.service';

/** The 8 columns the CSV header declares — and now the only fields read. */
const EXPORT_SELECT = {
  id: true,
  workspaceId: true,
  organizationId: true,
  actorUserId: true,
  action: true,
  resourceType: true,
  resourceId: true,
  createdAt: true,
};

const row = () => ({
  id: 'log-1',
  workspaceId: 'ws-1',
  organizationId: 'org-1',
  actorUserId: 'user-1',
  action: 'agent.updated',
  resourceType: 'agent',
  resourceId: 'agent-1',
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
});

function makeService(rows: ReturnType<typeof row>[] = [row()]) {
  const findMany = vi.fn(async (_args: { select: Record<string, true> }) => rows);
  return {
    findMany,
    service: new AuditExportService({ auditLog: { findMany } } as never, { send: vi.fn() } as never),
  };
}

/**
 * The `org_id` validation lives in a pipe bound by the @Query decorator, so a
 * direct handler call bypasses it — exactly as a test that only called the
 * handler would. Pull the pipes off the route metadata and run them the way
 * Nest does, which also fails if the binding is deleted.
 */
function orgIdPipes(): readonly PipeTransform[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, AuditExportController, 'adminExport') ??
    {}) as Record<string, { data?: string; pipes?: PipeTransform[] }>;
  const orgIdArg = Object.values(args).find((a) => a.data === 'org_id');
  return orgIdArg?.pipes ?? [];
}

describe('admin/audit/export org_id requirement', () => {
  // Omitting `org_id` produced `where: {}`, i.e. 10k audit rows across every
  // tenant on the platform. Rejected at the edge...
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('rejects a %s org_id at the controller', (_name, value) => {
    const pipes = orgIdPipes();
    expect(pipes).toHaveLength(1);

    for (const pipe of pipes) {
      expect(() => pipe.transform(value, { type: 'query' })).toThrow(ValidationError);
    }
  });

  it('accepts an org_id', () => {
    for (const pipe of orgIdPipes()) {
      expect(pipe.transform('org-1', { type: 'query' })).toBe('org-1');
    }
  });

  // ...and again in the service, which both export routes funnel through, so
  // the all-tenant read cannot be reintroduced by a new caller.
  it.each([undefined, '', '  '])('throws in the service when reached with %o', async (orgId) => {
    const { service, findMany } = makeService();

    await expect(
      service.getAuditLogs({ orgId: orgId as string, format: 'json' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('scopes the query to the organization', async () => {
    const { service, findMany } = makeService();

    await service.getAuditLogs({ orgId: 'org-1', format: 'json' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    );
  });
});

describe('audit export projection', () => {
  it('reads only the fields the export exposes', async () => {
    const { service, findMany } = makeService();

    await service.getAuditLogs({ orgId: 'org-1', format: 'json' });

    const { select } = findMany.mock.calls[0][0];
    expect(select).toEqual(EXPORT_SELECT);
    // Named explicitly because these are the ones that used to ride along: the
    // JSON branch returned whole rows, handing free-form metadata plus the
    // actor's IP and user agent to whoever holds the export.
    for (const field of ['metadata', 'ipAddress', 'userAgent']) {
      expect(select).not.toHaveProperty(field);
    }
  });

  it('serves CSV from the projected fields alone', async () => {
    const { service } = makeService();

    const csv = await service.getAuditLogs({ orgId: 'org-1', format: 'csv' });

    expect(csv).toBe(
      'id,workspace_id,organization_id,actor_user_id,action,resource_type,resource_id,created_at\n' +
        'log-1,ws-1,org-1,user-1,agent.updated,agent,agent-1,2026-08-29T00:00:00.000Z',
    );
  });
});

describe('signed audit report', () => {
  /** Enough rows that the report exceeds the 10k chars `content` used to keep. */
  const rows = Array.from({ length: 200 }, (_, i) => ({ ...row(), id: `log-${i}` }));

  function makeReportService() {
    const findMany = vi.fn(async (_args: { select: Record<string, true> }) => rows);
    const create = vi.fn(
      async (_args: { data: { token: string; content: string; contentHash: string } }) => ({
        id: 'report-1',
      }),
    );
    const send = vi.fn(async () => undefined);
    return {
      findMany,
      create,
      send,
      report: () =>
        new AuditExportService(
          { auditLog: { findMany }, auditReport: { create } } as never,
          { send } as never,
        ).generateSignedReport(
          'org-1',
          new Date('2026-08-01T00:00:00.000Z'),
          new Date('2026-08-29T00:00:00.000Z'),
          'auditor@example.com',
        ),
    };
  }

  // The report is handed to an EXTERNAL auditor, and it read whole rows.
  it('reads the same projection as the export', async () => {
    const { report, findMany } = makeReportService();

    await report();

    const { select } = findMany.mock.calls[0][0];
    expect(select).toEqual(EXPORT_SELECT);
    for (const field of ['metadata', 'ipAddress', 'userAgent']) {
      expect(select).not.toHaveProperty(field);
    }
  });

  // contentHash covered the untruncated JSON while content was sliced to 10k,
  // so any report over 10KB stored a signature nothing could re-verify.
  it('stores content that verifies against the stored hash', async () => {
    const { report, create } = makeReportService();

    const { hash } = await report();

    const { content, contentHash } = create.mock.calls[0][0].data;
    expect(content.length).toBeGreaterThan(10000);
    expect(content).toBe(JSON.stringify(rows));
    expect(contentHash).toBe(hash);
    expect(createHmac('sha256', env.ENCRYPTION_KEY ?? 'dev-secret-key').update(content).digest('hex')).toBe(hash);
  });

  // S-007: the token is a bearer credential for 72h of one org's audit log, so
  // the row stores only a digest. Nothing serves /api/audit/report/:token, so
  // no link is issued and no auditor is emailed a guaranteed 404.
  it('issues no download link and emails nobody', async () => {
    const { report, create, send } = makeReportService();

    const result = await report();

    expect(result).toEqual({
      reportId: 'report-1',
      expiresAt: expect.any(Date),
      hash: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toMatch(/http/);
    expect(send).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.token).toMatch(/^[0-9a-f]{64}$/);
  });
});
