import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditPayload {
  /**
   * Owning organization. Billing decisions (entitlements, credit, provider
   * cost, reconciliation) are organization-scoped and frequently have no
   * workspace, so this must be recorded independently of `workspaceId`.
   */
  organizationId?: string | null;
  workspaceId?: string | null;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(payload: AuditPayload): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: await this.resolveOrganizationId(payload),
        workspaceId: payload.workspaceId ?? null,
        actorUserId: payload.actorUserId ?? null,
        action: payload.action,
        resourceType: payload.resourceType,
        resourceId: payload.resourceId ?? null,
        metadata: payload.metadata
          ? (payload.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        ipAddress: payload.ipAddress ?? null,
        userAgent: payload.userAgent ?? null,
      },
    });
  }

  /**
   * Prefer the explicit organization. Otherwise derive it from the workspace so
   * existing workspace-scoped callers become organization-queryable without
   * every call site changing at once. A lookup failure must never discard the
   * audit record itself.
   */
  private async resolveOrganizationId(payload: AuditPayload): Promise<string | null> {
    if (payload.organizationId) return payload.organizationId;
    if (!payload.workspaceId) return null;

    try {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: payload.workspaceId },
        select: { organizationId: true },
      });
      return workspace?.organizationId ?? null;
    } catch (error) {
      this.logger.error(
        `Failed to resolve organization for audit workspace ${payload.workspaceId}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
