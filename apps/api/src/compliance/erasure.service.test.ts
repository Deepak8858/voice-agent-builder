import { beforeEach, describe, expect, it, vi } from 'vitest';

// The erasure path drives the real PhoneNumbersService.release, which reads these
// at call time and throws TWILIO_NOT_CONFIGURED without them. Mirrors
// phone-numbers.service.test.ts.
const envState = vi.hoisted(() => ({
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'token',
}));
vi.mock('../config/env', () => ({ env: envState }));

import { ErasureService } from './erasure.service';
import { PhoneNumbersService } from '../phone-numbers/phone-numbers.service';

// Every workspace-scoped model the erasure path must clear. Mirrors the
// non-CASCADE foreign keys pointing at `workspaces`.
const WORKSPACE_SCOPED_MODELS = [
  'toolInvocation',
  'analyticsEvent',
  'callEvaluation',
  'callEvent',
  'complianceCheck',
  'knowledgeChunk',
  'knowledgeSource',
  'call',
  'consentRecord',
  'contact',
  'dncEntry',
  'integrationTool',
  'agentTemplate',
  'agent',
  'membership',
] as const;

interface KnowledgeRow {
  fileUrl: string | null;
  metadata: unknown;
}

interface PhoneNumberRow {
  id: string;
  workspaceId: string;
  phoneNumber: string;
  type: string;
  twilioSid: string | null;
  agentId?: string | null;
}

describe('ErasureService', () => {
  function makeService(opts: {
    contact?: { id: string; phone: string; organizationId?: string } | null;
    calls?: Array<{ id: string }>;
    organization?: { id: string; name: string; ownerUserId?: string } | null;
    workspaces?: Array<{ id: string }>;
    knowledgeSources?: KnowledgeRow[];
    deleteStoredFileImpl?: (file: unknown) => Promise<void>;
    user?: { id: string; email: string; authUserId: string | null } | null;
    memberships?: Array<{ workspaceId: string; userId: string }>;
    subscription?: {
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      status: string;
    } | null;
    phoneNumbers?: PhoneNumberRow[];
  }) {
    const deletedContacts: string[] = [];
    const deletedWorkspaces: string[] = [];
    const deletedOrganizations: string[] = [];
    // Rows written through `tx.auditLog.create`, i.e. inside the erasure
    // transaction. `audit.log` below is the separate AuditService path, used only
    // by PhoneNumbersService.release.
    const auditLogs: Array<Record<string, unknown>> = [];
    // Records the order in which models were cleared so we can assert that
    // child rows are removed before the parents they reference.
    const deleteOrder: string[] = [];
    const deletedNumbers: string[] = [];
    const liveNumbers: PhoneNumberRow[] = [...(opts.phoneNumbers ?? [])];

    const prisma: Record<string, unknown> = {
      contact: {
        findFirst: vi.fn(async () => opts.contact ?? null),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deletedContacts.push(where.id);
          return { id: where.id };
        }),
        deleteMany: vi.fn(async () => {
          deleteOrder.push('contact');
          return { count: 0 };
        }),
      },
      call: {
        findMany: vi.fn(async () => opts.calls ?? []),
        deleteMany: vi.fn(async () => {
          deleteOrder.push('call');
          return { count: 0 };
        }),
      },
      organization: {
        findUnique: vi.fn(async () => opts.organization ?? null),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deletedOrganizations.push(where.id);
          return { id: where.id };
        }),
      },
      workspace: {
        findMany: vi.fn(async () => opts.workspaces ?? []),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deleteOrder.push(`workspace:${where.id}`);
          deletedWorkspaces.push(where.id);
          return { id: where.id };
        }),
      },
      knowledgeSource: {
        findMany: vi.fn(async () => opts.knowledgeSources ?? []),
        deleteMany: vi.fn(async () => {
          deleteOrder.push('knowledgeSource');
          return { count: 0 };
        }),
      },
      user: {
        findUnique: vi.fn(async () => opts.user ?? null),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
      },
      membership: {
        findMany: vi.fn(async () => opts.memberships ?? []),
        deleteMany: vi.fn(async () => {
          deleteOrder.push('membership');
          return { count: 0 };
        }),
      },
      workspaceMembership: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      subscription: {
        findUnique: vi.fn(async () => opts.subscription ?? null),
      },
      referral: {
        deleteMany: vi.fn(async () => {
          deleteOrder.push('referral');
          return { count: 0 };
        }),
      },
      // The non-transactional client. Reachable only by a regression that writes
      // the erasure audit row through `this.prisma` instead of `tx`, which is the
      // defect wearing a disguise: it commits on its own connection whatever the
      // transaction does. Rows written here are deliberately NOT rolled back.
      auditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditLogs.push(data);
          return { id: 'audit-1', ...data };
        }),
      },
      // Not in WORKSPACE_SCOPED_MODELS: the workspace foreign key is ON DELETE
      // CASCADE, which is exactly the problem -- the rows go away carrying the
      // only copy of `twilioSid`. Erasure must hand each number back first.
      twilioPhoneNumber: {
        findMany: vi.fn(async () => opts.phoneNumbers ?? []),
        findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) =>
          liveNumbers.find((n) => n.id === where.id && n.workspaceId === where.workspaceId) ?? null,
        ),
        deleteMany: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => {
          const idx = liveNumbers.findIndex(
            (n) => n.id === where.id && n.workspaceId === where.workspaceId,
          );
          if (idx === -1) return { count: 0 };
          liveNumbers.splice(idx, 1);
          deleteOrder.push(`twilioPhoneNumber:${where.id}`);
          deletedNumbers.push(where.id);
          return { count: 1 };
        }),
      },
    };

    for (const model of WORKSPACE_SCOPED_MODELS) {
      if (!prisma[model]) {
        prisma[model] = {
          deleteMany: vi.fn(async () => {
            deleteOrder.push(model);
            return { count: 0 };
          }),
        };
      }
    }

    // The transaction client is a separate object with its own `auditLog`, so the
    // mock can tell a `tx.auditLog.create` from a `this.prisma.auditLog.create`.
    // Only the former rolls back -- which is the whole point of the fix.
    const txAuditRows = new Set<Record<string, unknown>>();
    const txAuditCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditLogs.push(data);
      txAuditRows.add(data);
      return { id: 'audit-1', ...data };
    });

    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      // Spread at call time so per-test overrides of e.g. `organization.delete`
      // are visible inside the transaction.
      try {
        await fn({ ...prisma, auditLog: { create: txAuditCreate } });
      } catch (err) {
        for (let i = auditLogs.length - 1; i >= 0; i -= 1) {
          if (txAuditRows.has(auditLogs[i])) auditLogs.splice(i, 1);
        }
        throw err;
      }
    });

    const audit = {
      log: vi.fn(async (data: Record<string, unknown>) => {
        auditLogs.push(data);
      }),
    };

    const deletedFiles: unknown[] = [];
    const fileStorage = {
      saveUploadedFile: vi.fn(),
      deleteStoredFile: vi.fn(async (file: unknown) => {
        if (opts.deleteStoredFileImpl) return opts.deleteStoredFileImpl(file);
        deletedFiles.push(file);
      }),
    };

    const invalidator = {
      invalidateWorkspaceList: vi.fn(async () => undefined),
      invalidateWorkspaceAccess: vi.fn(async () => undefined),
      invalidateSession: vi.fn(async () => undefined),
      invalidateOrgAccess: vi.fn(async () => undefined),
    };

    // The real service, not a stub: skipping `type === 'byo'`, calling the
    // carrier before dropping the row and refusing on a carrier error all live
    // in there, and this is also what pins the argument order of the call.
    // `billing` is unused by release().
    const phoneNumbers = new PhoneNumbersService(prisma as never, audit as never, undefined);

    return {
      // No AuditService argument: erasure audit rows are written by the erasure
      // transaction itself, through `tx.auditLog.create`.
      service: new ErasureService(
        prisma as never,
        fileStorage as never,
        invalidator as never,
        phoneNumbers,
      ),
      prisma,
      audit,
      fileStorage,
      invalidator,
      deletedContacts,
      deletedWorkspaces,
      deletedOrganizations,
      deletedFiles,
      deletedNumbers,
      deleteOrder,
      auditLogs,
      // `tx.auditLog.create`, i.e. the in-transaction path.
      auditLogCreate: txAuditCreate,
    };
  }

  function s3Source(path: string): KnowledgeRow {
    return {
      fileUrl: `s3://voiceforge-knowledge/${path}`,
      metadata: {
        storage_provider: 's3',
        storage_bucket: 'voiceforge-knowledge',
        storage_path: path,
      },
    };
  }

  it('should be defined', () => {
    const { service } = makeService({});
    expect(service).toBeDefined();
  });

  describe('eraseContact', () => {
    it('should return contact not found for non-existent contact', async () => {
      const { service, auditLogs } = makeService({ contact: null });
      const result = await service.eraseContact('ws-1', 'contact-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Contact not found');
      expect(auditLogs).toEqual([]);
    });

    /**
     * S-018. The erasure audit row exists to attest that the deletion happened,
     * so it has to be written by the same transaction: committed ahead of one
     * that rolls back, it is a false attestation.
     */
    it('writes the audit row inside the transaction, before the delete', async () => {
      const { service, prisma, auditLogs, auditLogCreate } = makeService({
        contact: { id: 'contact-1', phone: '+14155550123', organizationId: 'org-1' },
        calls: [{ id: 'call-1' }],
      });

      const result = await service.eraseContact('ws-1', 'contact-1');

      expect(result.success).toBe(true);
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        workspaceId: 'ws-1',
        // AuditService would have resolved this from the workspace; the contact
        // row already carries it.
        organizationId: 'org-1',
        action: 'gdpr.contact.erased',
        resourceId: 'contact-1',
        metadata: expect.objectContaining({ contactPhone: '+14155550123' }),
      });
      const del = (prisma.contact as { delete: ReturnType<typeof vi.fn> }).delete;
      const tx = prisma.$transaction as ReturnType<typeof vi.fn>;
      // Inside: after $transaction opened. Before: `audit_logs.workspace_id` is a
      // real foreign key, and one failed statement aborts a Postgres transaction.
      expect(tx.mock.invocationCallOrder[0]).toBeLessThan(auditLogCreate.mock.invocationCallOrder[0]);
      expect(auditLogCreate.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
    });

    it('leaves no audit row when the deletion rolls back', async () => {
      const { service, prisma, auditLogs } = makeService({
        contact: { id: 'contact-1', phone: '+14155550123', organizationId: 'org-1' },
      });
      (prisma.contact as { delete: ReturnType<typeof vi.fn> }).delete = vi.fn(async () => {
        throw new Error('update or delete on table "contacts" violates foreign key constraint');
      });

      await expect(service.eraseContact('ws-1', 'contact-1')).rejects.toThrow('foreign key');
      expect(auditLogs).toEqual([]);
    });
  });

  describe('eraseOrganization', () => {
    it('returns an error for a non-existent organization', async () => {
      const { service } = makeService({ organization: null });
      const result = await service.eraseOrganization('org-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Organization not found');
    });

    it('clears every workspace-scoped table before deleting the workspace', async () => {
      const { service, prisma, deleteOrder, deletedOrganizations } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      // Every non-cascade child table must be cleared, otherwise Postgres
      // aborts the delete with a foreign key violation.
      for (const model of WORKSPACE_SCOPED_MODELS) {
        const client = prisma[model] as { deleteMany: ReturnType<typeof vi.fn> };
        expect(client.deleteMany, `${model}.deleteMany was not called`).toHaveBeenCalledWith({
          where: { workspaceId: 'ws-1' },
        });
      }
      // Memberships are the constraint that previously aborted erasure outright.
      expect(deleteOrder.indexOf('membership')).toBeLessThan(deleteOrder.indexOf('workspace:ws-1'));
      // Chunks reference sources; sources reference agents.
      expect(deleteOrder.indexOf('knowledgeChunk')).toBeLessThan(deleteOrder.indexOf('knowledgeSource'));
      expect(deleteOrder.indexOf('knowledgeSource')).toBeLessThan(deleteOrder.indexOf('agent'));
      expect(deleteOrder.indexOf('call')).toBeLessThan(deleteOrder.indexOf('agent'));
      // referrals.referrer_workspace_id is ON DELETE RESTRICT, so these rows
      // must be gone before the workspace or Postgres aborts the erasure.
      expect(
        (prisma.referral as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany,
      ).toHaveBeenCalledWith({ where: { referrerWorkspaceId: 'ws-1' } });
      expect(deleteOrder.indexOf('referral')).toBeLessThan(deleteOrder.indexOf('workspace:ws-1'));
      expect(deletedOrganizations).toEqual(['org-1']);
    });

    /**
     * F-029. `subscriptions.organization_id` is ON DELETE CASCADE and that row
     * holds the only copy of the Stripe ids, so deleting the organization while
     * the subscription is live leaves Stripe charging the card with nothing here
     * able to identify, let alone cancel, it.
     */
    it('refuses to delete an organization with a live Stripe subscription', async () => {
      const { service, prisma, deletedOrganizations, audit, auditLogs } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        subscription: {
          stripeCustomerId: 'cus_live',
          stripeSubscriptionId: 'sub_live',
          status: 'active',
        },
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('sub_live');
      // Nothing may be destroyed: the Stripe id must stay resolvable.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(deletedOrganizations).toEqual([]);
      // A refusal claims no erasure, so it writes no erasure row -- by either
      // path, the in-transaction one or AuditService.
      expect(auditLogs).toEqual([]);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('still refuses when the live subscription is only past_due', async () => {
      const { service, deletedOrganizations } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        subscription: {
          stripeCustomerId: 'cus_live',
          stripeSubscriptionId: 'sub_live',
          status: 'past_due',
        },
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(false);
      expect(deletedOrganizations).toEqual([]);
    });

    it('proceeds for a customer row that has no subscription attached', async () => {
      // A free org that merely opened the billing portal has a subscription row
      // with the default status 'active' and no stripeSubscriptionId. Refusing
      // on status alone would make every free org un-erasable.
      const { service, deletedOrganizations } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        subscription: {
          stripeCustomerId: 'cus_free',
          stripeSubscriptionId: null,
          status: 'active',
        },
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(deletedOrganizations).toEqual(['org-1']);
    });

    it('records the Stripe handles in the audit row before the cascade drops them', async () => {
      const { service, auditLogs, deletedOrganizations } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        subscription: {
          stripeCustomerId: 'cus_gone',
          stripeSubscriptionId: 'sub_gone',
          status: 'canceled',
        },
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(deletedOrganizations).toEqual(['org-1']);
      // audit_logs.organization_id has no foreign key, so this row survives the
      // organization and is the only remaining way back to the Stripe customer.
      expect(auditLogs[0]).toMatchObject({
        organizationId: 'org-1',
        action: 'gdpr.organization_deleted',
        metadata: expect.objectContaining({
          stripeCustomerId: 'cus_gone',
          stripeSubscriptionId: 'sub_gone',
          stripeSubscriptionStatus: 'canceled',
        }),
      });
    });

    /**
     * S-018. `billing_ledger_entries.organization_id` and
     * `provider_cost_events.organization_id` are ON DELETE RESTRICT, so this
     * transaction throws for any organization that has ever paid an invoice or
     * placed a call -- the common case, not the rare one. The audit row used to be
     * committed before it, leaving a compliance record asserting an erasure that
     * never happened.
     */
    it('leaves no audit row when the erasure transaction rolls back', async () => {
      const { service, prisma, auditLogs, deletedOrganizations } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
      });
      (prisma.organization as { delete: ReturnType<typeof vi.fn> }).delete = vi.fn(async () => {
        throw new Error(
          'update or delete on table "organizations" violates foreign key constraint '
          + '"billing_ledger_entries_organization_id_fkey"',
        );
      });

      await expect(service.eraseOrganization('org-1')).rejects.toThrow('violates foreign key');
      expect(auditLogs).toEqual([]);
      expect(deletedOrganizations).toEqual([]);
    });

    it('writes the audit row inside the transaction, before the deletes', async () => {
      const { service, prisma, auditLogCreate } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
      });

      await service.eraseOrganization('org-1');

      const orgDelete = (prisma.organization as { delete: ReturnType<typeof vi.fn> }).delete;
      const tx = prisma.$transaction as ReturnType<typeof vi.fn>;
      const auditAt = auditLogCreate.mock.invocationCallOrder[0];
      expect(tx.mock.invocationCallOrder[0]).toBeLessThan(auditAt);
      expect(auditAt).toBeLessThan(orgDelete.mock.invocationCallOrder[0]);
      // The Stripe read has to stay ahead of it: the subscription row is the only
      // copy of the handles the row records, and it is ON DELETE CASCADE.
      const subRead = (prisma.subscription as { findUnique: ReturnType<typeof vi.fn> }).findUnique;
      expect(subRead.mock.invocationCallOrder[0]).toBeLessThan(auditAt);
    });

    it('deletes stored knowledge files for every workspace in the organization', async () => {
      const { service, fileStorage, deletedFiles } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }],
        knowledgeSources: [s3Source('knowledge/a.pdf'), s3Source('knowledge/b.pdf')],
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(fileStorage.deleteStoredFile).toHaveBeenCalledTimes(2);
      expect(deletedFiles).toEqual([
        expect.objectContaining({ provider: 's3', bucket: 'voiceforge-knowledge', path: 'knowledge/a.pdf' }),
        expect.objectContaining({ provider: 's3', bucket: 'voiceforge-knowledge', path: 'knowledge/b.pdf' }),
      ]);
    });

    it('routes deletion by the stored provider, not the current config', async () => {
      const { service, deletedFiles } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [
          {
            fileUrl: 'https://project.supabase.co/storage/v1/object/kb/legacy.pdf',
            metadata: {
              storage_provider: 'supabase',
              storage_bucket: 'kb',
              storage_path: 'legacy.pdf',
            },
          },
          s3Source('knowledge/new.pdf'),
        ],
      });

      await service.eraseOrganization('org-1');

      expect(deletedFiles).toEqual([
        expect.objectContaining({ provider: 'supabase', bucket: 'kb' }),
        expect.objectContaining({ provider: 's3', bucket: 'voiceforge-knowledge' }),
      ]);
    });

    it('collects storage coordinates before the rows are deleted', async () => {
      const { service, prisma } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [s3Source('knowledge/a.pdf')],
      });

      await service.eraseOrganization('org-1');

      // The metadata lives on the rows themselves, so it must be read before
      // the transaction removes them.
      const findMany = (prisma.knowledgeSource as { findMany: ReturnType<typeof vi.fn> }).findMany;
      const deleteMany = (prisma.knowledgeSource as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany;
      expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]);
    });

    it('ignores rows whose metadata has no usable storage coordinates', async () => {
      const { service, fileStorage } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [
          { fileUrl: null, metadata: null },
          { fileUrl: 'https://example.com/x.pdf', metadata: { storage_provider: 'unknown' } },
          { fileUrl: 'https://example.com/y.pdf', metadata: { storage_provider: 's3' } },
        ],
      });

      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(fileStorage.deleteStoredFile).not.toHaveBeenCalled();
    });

    it('still reports success when storage deletion fails', async () => {
      const { service } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [s3Source('knowledge/a.pdf')],
        deleteStoredFileImpl: async () => {
          throw new Error('AccessDenied');
        },
      });

      // The database rows are already gone; throwing here would report failure
      // for an erasure that actually happened.
      const result = await service.eraseOrganization('org-1');

      expect(result.success).toBe(true);
      expect(result.erasedAt).toBeDefined();
    });

    it('does not purge storage when the erasure transaction fails', async () => {
      const { service, prisma, fileStorage } = makeService({
        organization: { id: 'org-1', name: 'Acme' },
        workspaces: [{ id: 'ws-1' }],
        knowledgeSources: [s3Source('knowledge/a.pdf')],
      });
      prisma.$transaction = vi.fn(async () => {
        throw new Error('deadlock detected');
      });

      await expect(service.eraseOrganization('org-1')).rejects.toThrow('deadlock detected');
      // Customer files must survive a rolled-back erasure.
      expect(fileStorage.deleteStoredFile).not.toHaveBeenCalled();
    });

    it('revokes cached access for every membership and the org owner', async () => {
      const { service, prisma, invalidator } = makeService({
        organization: { id: 'org-1', name: 'Acme', ownerUserId: 'owner-1' },
        workspaces: [{ id: 'ws-1' }],
        memberships: [
          { workspaceId: 'ws-1', userId: 'user-1' },
          { workspaceId: 'ws-1', userId: 'user-2' },
        ],
      });

      await service.eraseOrganization('org-1');

      // Enumerated before deleteMany wipes the only record of who to revoke.
      const findMany = (prisma.membership as { findMany: ReturnType<typeof vi.fn> }).findMany;
      const deleteMany = (prisma.membership as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany;
      expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]);
      for (const userId of ['user-1', 'user-2']) {
        expect(invalidator.invalidateWorkspaceAccess).toHaveBeenCalledWith('ws-1', userId);
        expect(invalidator.invalidateWorkspaceList).toHaveBeenCalledWith(userId);
        expect(invalidator.invalidateSession).toHaveBeenCalledWith({ appUserId: userId });
        expect(invalidator.invalidateOrgAccess).toHaveBeenCalledWith('org-1', userId);
      }
      // OrganizationGuard grants by ownership too, without any membership row.
      expect(invalidator.invalidateOrgAccess).toHaveBeenCalledWith('org-1', 'owner-1');
    });

    /**
     * `twilio_phone_numbers.workspace_id` is ON DELETE CASCADE, so erasing the
     * workspace deletes the number rows and with them `twilioSid` -- the only
     * handle that can ever release the number. The number then bills monthly on
     * VoiceForge's own Twilio account forever, unreachable from this product.
     */
    describe('carrier release', () => {
      let fetchMock: ReturnType<typeof vi.fn>;

      function number(over: Partial<PhoneNumberRow> & { id: string }): PhoneNumberRow {
        return {
          workspaceId: 'ws-1',
          phoneNumber: `+1415555${over.id.slice(-4).padStart(4, '0')}`,
          type: 'local',
          twilioSid: `PN${over.id}`,
          agentId: null,
          ...over,
        };
      }

      beforeEach(() => {
        fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
        vi.stubGlobal('fetch', fetchMock);
      });

      it('releases every non-BYO number at the carrier before the cascade deletes it', async () => {
        const { service, prisma, deleteOrder, deletedNumbers } = makeService({
          organization: { id: 'org-1', name: 'Acme' },
          workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }],
          phoneNumbers: [
            number({ id: '0001' }),
            number({ id: '0002', workspaceId: 'ws-2', type: 'tollfree' }),
          ],
        });

        const result = await service.eraseOrganization('org-1');

        expect(result.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const sid of ['PN0001', 'PN0002']) {
          expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining(`/IncomingPhoneNumbers/${sid}.json`),
            expect.objectContaining({ method: 'DELETE' }),
          );
        }
        // Carrier first: a row dropped before a successful release is the orphan.
        const workspaceDelete = (prisma.workspace as { delete: ReturnType<typeof vi.fn> }).delete;
        expect(fetchMock.mock.invocationCallOrder[0])
          .toBeLessThan(workspaceDelete.mock.invocationCallOrder[0]);
        expect(deletedNumbers).toEqual(['0001', '0002']);
        expect(deleteOrder.indexOf('twilioPhoneNumber:0001'))
          .toBeLessThan(deleteOrder.indexOf('workspace:ws-1'));
      });

      it('does not send a BYO number to the carrier', async () => {
        // A BYO number lives on the customer's own Twilio account, so releasing
        // it would delete someone else's number. `addByo` still records a sid.
        const { service, deletedOrganizations } = makeService({
          organization: { id: 'org-1', name: 'Acme' },
          workspaces: [{ id: 'ws-1' }],
          phoneNumbers: [number({ id: '0003', type: 'byo' })],
        });

        const result = await service.eraseOrganization('org-1');

        expect(result.success).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deletedOrganizations).toEqual(['org-1']);
      });

      it('aborts the erasure with nothing deleted when the carrier refuses', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        const {
          service, prisma, deletedOrganizations, deletedWorkspaces, deletedNumbers, audit, auditLogs,
        } =
          makeService({
            organization: { id: 'org-1', name: 'Acme' },
            workspaces: [{ id: 'ws-1' }],
            phoneNumbers: [number({ id: '0004' })],
          });

        const result = await service.eraseOrganization('org-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('+14155550004');
        // Nothing may be destroyed: the sid must stay resolvable for the retry.
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(deletedNumbers).toEqual([]);
        expect(deletedWorkspaces).toEqual([]);
        expect(deletedOrganizations).toEqual([]);
        // A refusal claims no erasure, so it writes no erasure row. `audit.log`
        // covers PhoneNumbersService.release too, which also got no further than
        // the failed carrier call.
        expect(auditLogs).toEqual([]);
        expect(audit.log).not.toHaveBeenCalled();
      });

      it('keeps the numbers it already released when a later one refuses', async () => {
        // Partial failure is the least-bad outcome available: the released rows
        // are gone, so a retry re-enumerates only what is still held, and the
        // one that refused keeps the sid needed to release it by hand.
        const { service, deletedNumbers, deletedOrganizations } = makeService({
          organization: { id: 'org-1', name: 'Acme' },
          workspaces: [{ id: 'ws-1' }],
          phoneNumbers: [number({ id: '0005' }), number({ id: '0006' })],
        });
        fetchMock
          .mockResolvedValueOnce({ ok: true, status: 204 })
          .mockResolvedValueOnce({ ok: false, status: 502 });

        const result = await service.eraseOrganization('org-1');

        expect(result.success).toBe(false);
        expect(deletedNumbers).toEqual(['0005']);
        expect(deletedOrganizations).toEqual([]);
      });

      it('erases a workspace with no numbers without touching the carrier', async () => {
        const { service, deletedOrganizations, deletedWorkspaces } = makeService({
          organization: { id: 'org-1', name: 'Acme' },
          workspaces: [{ id: 'ws-1' }],
          phoneNumbers: [],
        });

        const result = await service.eraseOrganization('org-1');

        expect(result.success).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deletedWorkspaces).toEqual(['ws-1']);
        expect(deletedOrganizations).toEqual(['org-1']);
      });
    });
  });

  describe('eraseUser', () => {
    it('revokes cached access for every workspace the user belonged to', async () => {
      const { service, prisma, invalidator } = makeService({
        user: { id: 'user-1', email: 'u@example.com', authUserId: 'auth-1' },
        memberships: [
          { workspaceId: 'ws-1', userId: 'user-1' },
          { workspaceId: 'ws-2', userId: 'user-1' },
        ],
      });

      const result = await service.eraseUser('user-1');

      expect(result.success).toBe(true);
      const findMany = (prisma.membership as { findMany: ReturnType<typeof vi.fn> }).findMany;
      const deleteMany = (prisma.membership as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany;
      expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]);
      expect(invalidator.invalidateWorkspaceAccess).toHaveBeenCalledWith('ws-1', 'user-1');
      expect(invalidator.invalidateWorkspaceAccess).toHaveBeenCalledWith('ws-2', 'user-1');
      expect(invalidator.invalidateWorkspaceList).toHaveBeenCalledWith('user-1');
      expect(invalidator.invalidateSession).toHaveBeenCalledWith({
        appUserId: 'user-1',
        supabaseUserId: 'auth-1',
      });
    });

    /**
     * S-018 / S-006. Inside the transaction so a rollback withdraws the claim,
     * and ahead of `user.delete` because `audit_logs.actor_user_id` is a real
     * foreign key (per `schema.prisma`, created by
     * `20260724090000_production_billing`): an insert naming an already-deleted
     * user aborts the whole transaction, so erasure would become impossible.
     */
    it('writes the audit row inside the transaction, before the user is deleted', async () => {
      const { service, prisma, auditLogs, auditLogCreate } = makeService({
        user: { id: 'user-1', email: 'u@example.com', authUserId: 'auth-1' },
      });

      await service.eraseUser('user-1');

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: 'gdpr.user_deleted',
        // `resource_id` and `metadata` have no foreign key, so they are what
        // survives: ON DELETE SET NULL empties `actor_user_id` at commit.
        resourceId: 'user-1',
        metadata: expect.objectContaining({ userEmail: 'u@example.com' }),
      });
      const userDelete = (prisma.user as { delete: ReturnType<typeof vi.fn> }).delete;
      const tx = prisma.$transaction as ReturnType<typeof vi.fn>;
      expect(tx.mock.invocationCallOrder[0]).toBeLessThan(auditLogCreate.mock.invocationCallOrder[0]);
      expect(auditLogCreate.mock.invocationCallOrder[0])
        .toBeLessThan(userDelete.mock.invocationCallOrder[0]);
    });

    it('leaves no audit row when the deletion rolls back', async () => {
      // Every signup makes the user an owner, and `organizations.owner_user_id`
      // is ON DELETE RESTRICT, so this is what actually happens today.
      const { service, prisma, auditLogs } = makeService({
        user: { id: 'user-1', email: 'u@example.com', authUserId: null },
      });
      (prisma.user as { delete: ReturnType<typeof vi.fn> }).delete = vi.fn(async () => {
        throw new Error(
          'update or delete on table "users" violates foreign key constraint '
          + '"organizations_owner_user_id_fkey"',
        );
      });

      await expect(service.eraseUser('user-1')).rejects.toThrow('violates foreign key');
      expect(auditLogs).toEqual([]);
    });

    it('writes no audit row for a user that does not exist', async () => {
      const { service, auditLogs, prisma } = makeService({ user: null });

      const result = await service.eraseUser('nope');

      expect(result.success).toBe(false);
      expect(auditLogs).toEqual([]);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
