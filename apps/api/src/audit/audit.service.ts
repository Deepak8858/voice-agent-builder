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

/**
 * Bound on the in-process workspace to organization memo. A workspace never
 * moves between organizations, so entries do not need invalidation — only a
 * ceiling, so a long-lived process serving many tenants cannot grow the map
 * without limit.
 */
const WORKSPACE_ORGANIZATION_CACHE_LIMIT = 10_000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly workspaceOrganizations = new Map<string, string>();

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
   *
   * Audit writes sit on request paths, so an uncached lookup would double the
   * database round trips for every workspace-scoped audit. The result is
   * memoized because a workspace's owning organization is fixed for the life of
   * the workspace; a negative or failed lookup is deliberately not cached, so a
   * transient outage cannot pin `null` onto every subsequent audit row for that
   * workspace.
   */
  private async resolveOrganizationId(payload: AuditPayload): Promise<string | null> {
    if (payload.organizationId) return payload.organizationId;
    if (!payload.workspaceId) return null;

    const cached = this.workspaceOrganizations.get(payload.workspaceId);
    if (cached) return cached;

    try {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: payload.workspaceId },
        select: { organizationId: true },
      });
      const organizationId = workspace?.organizationId ?? null;
      if (organizationId) this.rememberWorkspace(payload.workspaceId, organizationId);
      return organizationId;
    } catch (error) {
      this.logger.error(
        `Failed to resolve organization for audit workspace ${payload.workspaceId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Insertion-ordered eviction; any bounded policy is adequate for a fixed mapping. */
  private rememberWorkspace(workspaceId: string, organizationId: string): void {
    if (this.workspaceOrganizations.size >= WORKSPACE_ORGANIZATION_CACHE_LIMIT) {
      const oldest = this.workspaceOrganizations.keys().next();
      if (!oldest.done) this.workspaceOrganizations.delete(oldest.value);
    }
    this.workspaceOrganizations.set(workspaceId, organizationId);
  }
}
