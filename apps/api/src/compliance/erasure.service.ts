import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hasLiveSubscription } from '@voiceforge/shared';
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

    // `subscriptions.organization_id` is ON DELETE CASCADE, and that row is the
    // only place the Stripe customer/subscription ids are stored. Read it before
    // the delete: afterwards there is nothing left to cancel the subscription by.
    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: { stripeCustomerId: true, stripeSubscriptionId: true, status: true },
    });

    // Ordering, deliberately: cancel-then-delete is the only recoverable order.
    // Cancel first and the delete fails -> the customer is un-billed but not yet
    // erased, and erasure can simply be retried. Delete first and the cancel
    // fails -> Stripe keeps charging the card every month and the id needed to
    // stop it went away with the cascade, which is unrecoverable through this
    // product. Nothing in this codebase can cancel a Stripe subscription (the
    // only Stripe writes are customers.create, checkout.sessions and
    // billingPortal.sessions), so the cancel half has to happen outside it: this
    // refuses instead of destroying the handle. Erasure is therefore delayed by
    // one operator action, never blocked on a Stripe call from this process --
    // Stripe returning 500 cannot wedge it, because it makes no Stripe call.
    // `stripeSubscriptionId` is the discriminator, not `status` alone: a free
    // org that merely opened the billing portal has a customer row with the
    // default status 'active' and no subscription.
    if (subscription?.stripeSubscriptionId && hasLiveSubscription(subscription.status)) {
      return {
        success: false,
        error:
          `Organization ${orgId} still has a live Stripe subscription `
          + `(${subscription.stripeSubscriptionId}, status "${subscription.status}"). Cancel it in `
          + `Stripe first, then retry: deleting the organization removes the only record of that id.`,
      };
    }

    await this.audit.log({
      organizationId: orgId,
      action: 'gdpr.organization_deleted',
      resourceType: 'organization',
      resourceId: orgId,
      metadata: {
        orgName: org.name,
        erasedAt: new Date().toISOString(),
        // Keeps the Stripe handles findable after the cascade removes the
        // subscription row. `audit_logs.organization_id` has no foreign key, so
        // this row outlives the organization it names.
        stripeCustomerId: subscription?.stripeCustomerId ?? null,
        stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
        stripeSubscriptionStatus: subscription?.status ?? null,
      },
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

    // A workspace's own templates carry its prompt text in `template_spec`. The
    // workspace foreign key is SET NULL, so without this the content survives
    // the erasure detached from any tenant instead of being removed.
    await tx.agentTemplate.deleteMany(scope);

    // `referrals.referrer_workspace_id` is ON DELETE RESTRICT, so a workspace
    // that ever sent a referral invite cannot be deleted while its rows exist --
    // this is the constraint that aborts erasure for any tenant that used the
    // referral programme. The mirror column `referred_workspace_id` is SET NULL
    // and those rows belong to the *referring* tenant, so they are left alone.
    await tx.referral.deleteMany({ where: { referrerWorkspaceId: workspaceId } });

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