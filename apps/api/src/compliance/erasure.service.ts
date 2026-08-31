import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hasLiveSubscription } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CacheInvalidator } from '../common/cache-invalidator';
import { PhoneNumbersService } from '../phone-numbers/phone-numbers.service';
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
    // No AuditService: every audit row this service writes has to be inserted by
    // the same transaction client as the deletion it attests to, which
    // AuditService cannot accept. See eraseContact.
    @Inject(KNOWLEDGE_FILE_STORAGE_TOKEN)
    private readonly fileStorage: KnowledgeFileStorage,
    private readonly invalidator: CacheInvalidator,
    private readonly phoneNumbers: PhoneNumbersService,
  ) {}

  async eraseContact(workspaceId: string, contactId: string): Promise<ErasureResult> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) {
      return { success: false, error: 'Contact not found' };
    }

    // Cascade: contact → consent_records (has cascade), calls (has cascade), compliance_checks (has cascade)
    // Additional: analytics_events, tool_invocations linked to those calls
    const calls = await this.prisma.call.findMany({
      where: { contactId },
      select: { id: true },
    });
    const callIds = calls.map(c => c.id);

    await this.prisma.$transaction(async (tx) => {
      // The audit row is written inside the transaction, and before the deletes.
      //
      // Inside, because an erasure log exists to attest that a deletion
      // happened: a row committed ahead of a transaction that then rolls back is
      // a false attestation to a regulator, which is worse than no row at all.
      // Writing it after the commit instead only swaps that for a permanent gap
      // (crash or a failed insert between commit and log leaves a real deletion
      // unrecorded, and the retry finds nothing left to erase). Inside the
      // transaction there is no failure direction to choose: the claim and the
      // deletion commit together or neither does.
      //
      // Written with `tx`, not `AuditService.log()`, because AuditService holds
      // its own `this.prisma` and takes no transaction client -- calling it from
      // in here would insert on a different connection and commit independently,
      // which is the same defect wearing a disguise. Several services already
      // write `auditLog.create` directly (billing, entitlement, dodo-webhook).
      // `organizationId` is taken from the contact row rather than resolved from
      // the workspace, which is what AuditService.log would have done.
      //
      // Before the deletes, because `audit_logs.workspace_id` and
      // `actor_user_id` are real foreign keys (per `schema.prisma`, and created
      // by `20260724090000_production_billing`); an insert naming a row this
      // transaction has already deleted fails, and in Postgres one failed
      // statement aborts the whole transaction.
      await tx.auditLog.create({
        data: {
          workspaceId,
          organizationId: contact.organizationId,
          action: 'gdpr.contact.erased',
          resourceType: 'contact',
          resourceId: contactId,
          metadata: { contactPhone: contact.phone, erasedAt: new Date().toISOString() },
        },
      });

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
    // only place the Dodo customer/subscription ids are stored. Read it before
    // the delete: afterwards there is nothing left to cancel the subscription by.
    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: { dodoCustomerId: true, dodoSubscriptionId: true, status: true },
    });

    // Ordering, deliberately: cancel-then-delete is the only recoverable order.
    // Cancel first and the delete fails -> the customer is un-billed but not yet
    // erased, and erasure can simply be retried. Delete first and the cancel
    // fails -> Dodo keeps charging the card every month and the id needed to
    // stop it went away with the cascade, which is unrecoverable through this
    // product. Nothing in this codebase can cancel a Dodo subscription (the
    // only Dodo writes are customers.create, checkoutSessions.create and
    // customers.customerPortal.create), so the cancel half has to happen outside
    // it: this refuses instead of destroying the handle. Erasure is therefore
    // delayed by one operator action, never blocked on a Dodo call from this
    // process -- Dodo returning 500 cannot wedge it, because it makes no Dodo
    // call. `dodoSubscriptionId` is the discriminator, not `status` alone: a free
    // org that merely opened the billing portal has a customer row with the
    // default status 'active' and no subscription.
    if (subscription?.dodoSubscriptionId && hasLiveSubscription(subscription.status)) {
      return this.refuseOrganizationErasure(
        orgId,
        'live_dodo_subscription',
        {
          dodoCustomerId: subscription.dodoCustomerId,
          dodoSubscriptionId: subscription.dodoSubscriptionId,
          dodoSubscriptionStatus: subscription.status,
        },
        `Organization ${orgId} still has a live Dodo subscription `
        + `(${subscription.dodoSubscriptionId}, status "${subscription.status}"). Cancel it in `
        + `Dodo first, then retry: deleting the organization removes the only record of that id.`,
      );
    }

    const workspaces = await this.prisma.workspace.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((ws) => ws.id);

    // The same ordering rule as the Dodo refusal above, applied to the
    // carrier. `twilio_phone_numbers.workspace_id` is ON DELETE CASCADE, so the
    // workspace delete below drops every number row -- and with it `twilioSid`,
    // the only handle that can ever release the number -- while the number keeps
    // billing monthly on VoiceForge's own Twilio account. Release-then-delete is
    // recoverable (retry; the number is already off the account);
    // delete-then-release is unrecoverable through this product. Enumerated
    // before the delete for the same reason as the memberships below: afterwards
    // there is nothing left to say which numbers existed. Outside the
    // transaction deliberately -- an external HTTP call must not hold one open,
    // and Postgres aborts the whole transaction on the first failed statement,
    // so a refusal could not be recovered from inside it.
    const numbers = workspaceIds.length === 0
      ? []
      : await this.prisma.twilioPhoneNumber.findMany({
          where: { workspaceId: { in: workspaceIds } },
          select: { id: true, workspaceId: true, phoneNumber: true },
        });
    for (const number of numbers) {
      // PhoneNumbersService.release already calls the carrier first and only
      // then drops the row, skips `type === 'byo'`, tolerates a concurrent
      // release and writes the `phone_number.release` audit entry.
      try {
        await this.phoneNumbers.release(number.workspaceId, number.id);
      } catch (err) {
        // Numbers released before this one stay released, which is the intended
        // end state for them; their rows are gone so a retry will not revisit
        // them. Refusing here leaves the rest of the tenant's data intact and
        // erasable on retry, whereas proceeding would strand this number.
        const carrierError = err instanceof Error ? err.message : String(err);
        return this.refuseOrganizationErasure(
          orgId,
          'carrier_release_refused',
          // `phone_number` is already recorded in the clear by
          // PhoneNumbersService.release's own audit row, and it is the tenant's
          // carrier-billed number, not a data subject's contact detail.
          { phoneNumber: number.phoneNumber, carrierError },
          `Organization ${orgId} still holds phone number ${number.phoneNumber} at the carrier: `
          + `${carrierError}. Release it, then retry: `
          + `deleting the workspace removes the only record of its Twilio SID.`,
        );
      }
    }

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

    // Historical `provider_cost_events` rows carry the tenant's phone number in
    // `metadata.phoneNumber`. Today's writer records `phoneNumberId` instead, but
    // the rows written before that change were never rewritten, and
    // `provider_cost_events.organization_id` is ON DELETE RESTRICT: these are
    // financial records that outlive the organization on purpose. So the row
    // stays and only the personal datum is stripped.
    //
    // Before the transaction and outside it, deliberately. That transaction fails
    // for any organization that ever placed a call -- on the RESTRICT constraint
    // held by these very rows -- which is the common case, so a redaction inside
    // it would roll back and leave the number in place on exactly the erasures
    // that need it removed. The redaction over-claims nothing if the delete then
    // fails: it destroys no financial figure, it is idempotent, and the erasure
    // request that asked for it was real whether or not the delete succeeded.
    //
    // Removing a jsonb key is not expressible in Prisma, so this is one
    // parameterised raw UPDATE, organization-scoped in its WHERE with the id
    // bound, never interpolated. Precedent: the retention re-stamp in
    // retention.service.ts. `jsonb_exists(...)` rather than the `?` operator so
    // the statement carries no character that a placeholder-rewriting driver
    // could mistake for a parameter.
    const redactedCostEvents = await this.prisma.$executeRaw`
      UPDATE provider_cost_events
         SET metadata = metadata - 'phoneNumber'
       WHERE organization_id = ${orgId}::uuid
         AND jsonb_exists(metadata, 'phoneNumber')
    `;

    await this.prisma.$transaction(async (tx) => {
      // Inside the transaction and before the deletes, for the reasons set out
      // in eraseContact: today every organization that has ever paid an invoice
      // or placed a call fails the delete below on an ON DELETE RESTRICT foreign
      // key, so the rolled-back case is the common case -- and it used to leave a
      // committed row claiming the organization had been erased.
      //
      // The two refusals above (live Dodo subscription, un-released number)
      // return before reaching this transaction and record themselves with a
      // distinct action; see refuseOrganizationErasure.
      await tx.auditLog.create({
        data: {
          organizationId: orgId,
          action: 'gdpr.organization_deleted',
          resourceType: 'organization',
          resourceId: orgId,
          metadata: {
            orgName: org.name,
            erasedAt: new Date().toISOString(),
            // Keeps the Dodo handles findable after the cascade removes the
            // subscription row. `audit_logs.organization_id` has no foreign key,
            // so this row outlives the organization it names.
            dodoCustomerId: subscription?.dodoCustomerId ?? null,
            dodoSubscriptionId: subscription?.dodoSubscriptionId ?? null,
            dodoSubscriptionStatus: subscription?.status ?? null,
          },
        },
      });

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
      {
        orgId,
        workspaces: workspaceIds.length,
        filesPurged: purged,
        filesFound: storedFiles.length,
        redactedCostEvents,
      },
      'GDPR organization erasure completed',
    );
    return { success: true, erasedAt };
  }

  /**
   * Records a refused organization erasure, then returns the refusal.
   *
   * A refusal is a data-subject-request outcome and has to be answerable later:
   * which organization was asked about, when, and on what grounds. Both callers
   * return immediately afterwards, so this method is the only place the refusal
   * is recorded.
   *
   * Written through `this.prisma`, outside any transaction, which is the inverse
   * of the rule set out in eraseContact for the inverse situation: a refusal
   * commits no mutation, so there is nothing for the row to over-claim -- it is
   * true the moment it is written and cannot be falsified by a rollback. Both
   * refusal paths also have to stay outside a transaction for their own reasons
   * (the carrier call must not hold one open, and Postgres aborts a whole
   * transaction on the first failed statement).
   *
   * No `actorUserId`: `DELETE admin/orgs/:orgId` is `@InternalOnly()`, which
   * rejects any request carrying user context, so no user id reaches this
   * service -- the same reason the success row above records none either.
   */
  private async refuseOrganizationErasure(
    orgId: string,
    reason: string,
    metadata: Record<string, string | null>,
    error: string,
  ): Promise<ErasureResult> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        action: 'gdpr.organization_erasure_refused',
        resourceType: 'organization',
        resourceId: orgId,
        metadata: { reason, refusedAt: new Date().toISOString(), ...metadata },
      },
    });
    this.logger.warn({ orgId, reason }, 'GDPR organization erasure refused');
    return { success: false, error };
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

    // `crm_fanout_log` has no foreign key to `workspaces` at all -- only
    // `call_id` and `agent_id`, both ON DELETE SET NULL -- so nothing cascades it
    // and the deletes below would leave every row behind holding `contact_data`:
    // the contact's name, phone and email as they were handed to the CRM. Its own
    // `workspace_id` column (added by 20260829000000_crm_fanout_log_workspace_id)
    // is what makes the rows reachable here, including the ones whose call or
    // agent link was nulled years ago.
    await tx.crmFanoutLog.deleteMany(scope);

    // `telephony_webhook_events.workspace_id` is ON DELETE SET NULL, so the
    // workspace delete below does not cascade these rows -- it empties the one
    // column that makes them reachable and leaves `raw_payload_json` behind. That
    // payload is the provider's own webhook body, which for a Twilio delivery
    // carries `From` and `To`: the caller's phone number, surviving the erasure
    // with nothing left to find it by. `call_id` cannot substitute, because it has
    // no foreign key either and most rows never had one.
    await tx.telephonyWebhookEvent.deleteMany(scope);

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

    // Enumerate before deleteMany: the rows are the only record of which
    // workspace access caches this user holds.
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { workspaceId: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // Inside the transaction and before the delete, for the reasons set out in
      // eraseContact. This method is self-service (the controller passes the
      // caller's own id), so the erased user is genuinely the actor -- but
      // `audit_logs.actor_user_id` is a foreign key with ON DELETE SET NULL, so
      // the column is emptied by the delete two statements below regardless of
      // when the row is written. The durable attribution is `resource_id` and
      // `metadata.userEmail`, neither of which has a foreign key. Ordering it the
      // other way round would not preserve the actor either, it would abort the
      // transaction on a foreign key violation and make erasure impossible.
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'gdpr.user_deleted',
          resourceType: 'user',
          resourceId: userId,
          metadata: { userEmail: user.email, erasedAt: new Date().toISOString() },
        },
      });

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