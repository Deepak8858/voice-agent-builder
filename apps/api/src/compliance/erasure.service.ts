import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheInvalidator } from '../common/cache-invalidator';
import {
  KNOWLEDGE_FILE_STORAGE_TOKEN,
  type KnowledgeFileStorage,
  type StoredKnowledgeFile,
} from '../knowledge/knowledge-file-storage.interface';

interface ErasureResult {
  success: boolean;
  erasedAt?: string;
  error?: string;
}

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(KNOWLEDGE_FILE_STORAGE_TOKEN)
    private readonly fileStorage: KnowledgeFileStorage,
    private readonly invalidator: CacheInvalidator,
  ) {}

  async eraseContact(workspaceId: string, contactId: string): Promise<ErasureResult> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) {
      return { success: false, error: 'Contact not found' };
    }

    // Log before deletion (audit trail)
    await this.audit.log({
      workspaceId,
      action: 'gdpr.contact.erased',
      resourceType: 'contact',
      resourceId: contactId,
      metadata: { contactPhone: contact.phone, erasedAt: new Date().toISOString() },
    });

    // Cascade: contact → consent_records (has cascade), calls (has cascade), compliance_checks (has cascade)
    // Additional: analytics_events, tool_invocations linked to those calls
    const calls = await this.prisma.call.findMany({
      where: { contactId },
      select: { id: true },
    });
    const callIds = calls.map(c => c.id);

    await this.prisma.$transaction(async (tx) => {
      // Delete analytics events for these calls
      if (callIds.length > 0) {
        await tx.analyticsEvent.deleteMany({ where: { callId: { in: callIds } } });
        await tx.callEvaluation.deleteMany({ where: { callId: { in: callIds } } });
        await tx.toolInvocation.deleteMany({ where: { callId: { in: callIds } } });
      }
      // Delete the contact (cascades to consent_records, calls, compliance_checks)
      await tx.contact.delete({ where: { id: contactId } });
    });

    const erasedAt = new Date().toISOString();
    this.logger.log({ contactId, workspaceId }, 'GDPR contact erasure completed');
    return { success: true, erasedAt };
  }

  async eraseOrganization(orgId: string): Promise<ErasureResult> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return { success: false, error: 'Organization not found' };

    await this.audit.log({
      action: 'gdpr.organization_deleted',
      resourceType: 'organization',
      resourceId: orgId,
      metadata: { orgName: org.name, erasedAt: new Date().toISOString() },
    });

    const workspaces = await this.prisma.workspace.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((ws) => ws.id);

    // Collect the stored objects before the rows are deleted; afterwards the
    // metadata that tells us which bucket/key to remove is gone forever.
    const storedFiles = await this.collectStoredFiles(workspaceIds);

    // Same before-delete rule for memberships: once the rows are gone there
    // is nothing left to say whose cached access needs revoking.
    const memberships = workspaceIds.length === 0
      ? []
      : await this.prisma.membership.findMany({
          where: { workspaceId: { in: workspaceIds } },
          select: { workspaceId: true, userId: true },
        });

    await this.prisma.$transaction(async (tx) => {
      for (const workspaceId of workspaceIds) {
        await this.deleteWorkspaceChildren(tx, workspaceId);
        await tx.workspace.delete({ where: { id: workspaceId } });
      }
      await tx.organization.delete({ where: { id: orgId } });
    });

    // Erased members must lose access on the next request, not when the
    // 300s access/session/org caches happen to expire.
    for (const { workspaceId, userId } of memberships) {
      await this.invalidator.invalidateWorkspaceAccess(workspaceId, userId);
      await this.invalidator.invalidateWorkspaceList(userId);
      await this.invalidator.invalidateSession({ appUserId: userId });
      await this.invalidator.invalidateOrgAccess(orgId, userId);
    }
    // OrganizationGuard also grants access by ownership, without a membership.
    if (org.ownerUserId) {
      await this.invalidator.invalidateOrgAccess(orgId, org.ownerUserId);
    }

    // Only purge storage once the database transaction has committed. Deleting
    // first would destroy customer files even if the erasure was rolled back.
    const purged = await this.purgeStoredFiles(storedFiles);

    const erasedAt = new Date().toISOString();
    this.logger.log(
      { orgId, workspaces: workspaceIds.length, filesPurged: purged, filesFound: storedFiles.length },
      'GDPR organization erasure completed',
    );
    return { success: true, erasedAt };
  }

  /**
   * Deletes every workspace-scoped row that does not have an ON DELETE CASCADE
   * foreign key back to `workspaces`.
   *
   * Relying on database cascades alone does not work: 19 foreign keys pointing
   * at `workspaces` are RESTRICT or SET NULL, so `workspace.delete()` fails with
   * a foreign key violation and the whole erasure request aborts. Order matters
   * because these tables also reference each other.
   */
  private async deleteWorkspaceChildren(
    tx: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<void> {
    const scope = { where: { workspaceId } };

    // Leaf rows that reference calls/contacts/sources must go before their parents.
    await tx.toolInvocation.deleteMany(scope);
    await tx.analyticsEvent.deleteMany(scope);
    await tx.callEvaluation.deleteMany(scope);
    await tx.callEvent.deleteMany(scope);
    await tx.complianceCheck.deleteMany(scope);
    await tx.knowledgeChunk.deleteMany(scope);
    await tx.knowledgeSource.deleteMany(scope);

    await tx.call.deleteMany(scope);
    await tx.consentRecord.deleteMany(scope);
    await tx.contact.deleteMany(scope);
    await tx.dncEntry.deleteMany(scope);
    await tx.integrationTool.deleteMany(scope);

    // Agents are referenced by knowledge sources (SET NULL) and calls, so they
    // are removed only after both are gone.
    await tx.agent.deleteMany(scope);

    // Membership rows are the constraint that currently aborts erasure outright.
    await tx.membership.deleteMany(scope);
  }

  /**
   * Reads the storage coordinates for every file-backed knowledge source in the
   * given workspaces. Mirrors KnowledgeService.storedFileFromMetadata: the
   * provider is taken from the row's own metadata rather than current config,
   * because older rows were written to Supabase and newer ones to S3.
   */
  private async collectStoredFiles(workspaceIds: string[]): Promise<StoredKnowledgeFile[]> {
    if (workspaceIds.length === 0) return [];

    const rows = await this.prisma.knowledgeSource.findMany({
      where: { workspaceId: { in: workspaceIds }, sourceType: 'file' },
      select: { fileUrl: true, metadata: true },
    });

    return rows
      .map((row) => this.storedFileFromMetadata(row.fileUrl, row.metadata))
      .filter((file): file is StoredKnowledgeFile => file !== null);
  }

  /**
   * Best-effort deletion of the underlying objects. A storage failure must not
   * resurrect already-deleted database rows, so failures are logged loudly for
   * follow-up rather than thrown; the erasure itself has already committed.
   */
  private async purgeStoredFiles(files: StoredKnowledgeFile[]): Promise<number> {
    let purged = 0;
    for (const file of files) {
      try {
        await this.fileStorage.deleteStoredFile(file);
        purged += 1;
      } catch (err) {
        this.logger.error(
          { provider: file.provider, bucket: file.bucket, path: file.path, err: String(err) },
          'GDPR erasure could not delete stored knowledge file; manual cleanup required',
        );
      }
    }
    return purged;
  }

  private storedFileFromMetadata(
    fileUrl: string | null,
    metadata: Prisma.JsonValue | null,
  ): StoredKnowledgeFile | null {
    if (!fileUrl || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const provider = metadata.storage_provider;
    const bucket = metadata.storage_bucket;
    const path = metadata.storage_path;
    const publicUrl = metadata.storage_public_url;
    if (
      (provider !== 'supabase' && provider !== 's3')
      || typeof bucket !== 'string'
      || typeof path !== 'string'
    ) {
      return null;
    }

    return {
      provider,
      bucket,
      path,
      fileUrl,
      publicUrl: typeof publicUrl === 'string' ? publicUrl : null,
    };
  }

  async eraseUser(userId: string): Promise<ErasureResult> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: 'User not found' };

    await this.audit.log({
      actorUserId: userId,
      action: 'gdpr.user_deleted',
      resourceType: 'user',
      resourceId: userId,
      metadata: { userEmail: user.email, erasedAt: new Date().toISOString() },
    });

    // Enumerate before deleteMany: the rows are the only record of which
    // workspace access caches this user holds.
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { workspaceId: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // Delete memberships
      await tx.membership.deleteMany({ where: { userId } });
      await tx.workspaceMembership.deleteMany({ where: { userId } });
      // Delete user
      await tx.user.delete({ where: { id: userId } });
    });

    // An erased user must stop authenticating on the next request, not when
    // the 300s access/session caches happen to expire.
    for (const { workspaceId } of memberships) {
      await this.invalidator.invalidateWorkspaceAccess(workspaceId, userId);
    }
    await this.invalidator.invalidateWorkspaceList(userId);
    await this.invalidator.invalidateSession({
      appUserId: userId,
      supabaseUserId: user.authUserId ?? undefined,
    });

    const erasedAt = new Date().toISOString();
    this.logger.log({ userId }, 'GDPR user erasure completed');
    return { success: true, erasedAt };
  }
}