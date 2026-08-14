import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { AuditService } from './audit.service';
import type { PrismaService } from '../prisma/prisma.service';

function createPrismaStub() {
  return {
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    workspace: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

describe('AuditService', () => {
  let prisma: ReturnType<typeof createPrismaStub>;
  let service: AuditService;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('records an explicit organization for a workspace-less billing decision', async () => {
    await service.log({
      organizationId: 'org-1',
      action: 'billing.reconciliation_correction',
      resourceType: 'organization_credit_balance',
      resourceId: 'balance-1',
      metadata: { correctedSeconds: 60 },
    });

    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        workspaceId: null,
        action: 'billing.reconciliation_correction',
        resourceType: 'organization_credit_balance',
        resourceId: 'balance-1',
      }),
    });
  });

  it('prefers the explicit organization over the workspace lookup', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-from-workspace' });

    await service.log({
      organizationId: 'org-explicit',
      workspaceId: 'ws-1',
      action: 'billing.quota_denied',
      resourceType: 'workspace',
    });

    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-explicit',
        workspaceId: 'ws-1',
      }),
    });
  });

  it('derives the organization from the workspace for existing callers', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-derived' });

    await service.log({
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      action: 'crm_credential.create',
      resourceType: 'workspace_crm_credential',
    });

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { organizationId: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-derived',
        workspaceId: 'ws-1',
      }),
    });
  });

  /**
   * Audit writes sit on request paths, so the workspace lookup is memoized. A
   * workspace never changes organization, so the second write must not cost a
   * second round trip.
   */
  it('resolves the organization once for repeated writes from the same workspace', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ organizationId: 'org-derived' });

    await service.log({
      workspaceId: 'ws-1',
      action: 'crm_credential.create',
      resourceType: 'workspace_crm_credential',
    });
    await service.log({
      workspaceId: 'ws-1',
      action: 'crm_credential.delete',
      resourceType: 'workspace_crm_credential',
    });

    expect(prisma.workspace.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ organizationId: 'org-derived', workspaceId: 'ws-1' }),
    });
  });

  it('still writes the audit record and reports the lookup failure', async () => {
    prisma.workspace.findUnique.mockRejectedValue(new Error('database unavailable'));
    const loggerError = vi.spyOn(
      (service as unknown as { logger: { error: (message: string) => void } }).logger,
      'error',
    );

    await expect(
      service.log({
        workspaceId: 'ws-1',
        action: 'white_label.update',
        resourceType: 'white_label_settings',
      }),
    ).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve organization for audit workspace ws-1'),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: null,
        workspaceId: 'ws-1',
      }),
    });
  });

  /**
   * A deleted or unknown workspace is a different branch from a failed lookup:
   * it resolves cleanly to no organization. The audit record must still be
   * written, because losing the trail is worse than an unattributed entry.
   */
  it('records a null organization when the workspace no longer exists', async () => {
    prisma.workspace.findUnique.mockResolvedValue(null);

    await service.log({
      workspaceId: 'ws-missing',
      action: 'white_label.update',
      resourceType: 'white_label_settings',
    });

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-missing' },
      select: { organizationId: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: null,
        workspaceId: 'ws-missing',
      }),
    });
  });

  it('writes JsonNull rather than undefined when no metadata is supplied', async () => {
    await service.log({
      organizationId: 'org-1',
      action: 'billing.enforcement_mode_changed',
      resourceType: 'organization',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: Prisma.JsonNull }),
    });
  });
});
