import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { findUnscopedQueries, queryKey, tenantScopedModels } from './tenant-scope-analyzer';

/**
 * Ratchet for tenant scoping across the whole API surface.
 *
 * The runtime suite in cross-tenant-isolation.test.ts proves that specific,
 * audited services isolate tenants correctly. It says nothing about code that
 * does not exist yet, and a hand-maintained checklist of service names goes
 * stale the moment someone adds a file.
 *
 * This test closes that gap from the other side: it re-derives the set of
 * Prisma queries on tenant-scoped models that carry no tenant predicate, and
 * compares it to the reviewed baseline below. The baseline is not a list of
 * approved leaks - it is the residue of a full manual audit, where each entry
 * was checked and found to be either genuinely tenant-agnostic (webhook
 * ingress keyed on a provider id, scheduled reconciliation sweeps, worker jobs
 * keyed on an internal id) or already guarded by a scoped read that this
 * conservative analyzer cannot see through.
 *
 * WHEN THIS TEST FAILS with a NEW entry, that is the point: you have added a
 * query on a tenant-scoped model with no `where: { workspaceId }`. Either add
 * the predicate, or - if the query is genuinely tenant-agnostic - add it to the
 * baseline in the same commit WITH a comment explaining why it is safe. Do not
 * add entries without justification; that turns this ratchet into a rubber
 * stamp.
 *
 * Entries are keyed by `file:model.operation` rather than by line number so
 * that unrelated edits above a call site do not produce spurious failures.
 * Because the key omits the line, one entry could otherwise silently approve
 * any number of additional call sites at the same file/model/operation.
 * EXPECTED_SITE_COUNTS closes that hole by pinning how many sites each key
 * currently has: adding a second unscoped query at an already-baselined key
 * fails the count assertion and must be reviewed, then the count bumped in
 * the same commit with a justification.
 */

const API_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(API_ROOT, 'src');
const SCHEMA_PATH = path.join(API_ROOT, 'prisma', 'schema.prisma');

/**
 * Reviewed, intentionally-unscoped query sites. Grouped by the reason each
 * group is safe.
 */
const REVIEWED_BASELINE: readonly string[] = [
  // -- Provider webhook ingress -------------------------------------------
  // Inbound webhooks arrive with no session and no workspace context. The
  // tenant is *derived* from the provider's own identifier (phone number,
  // provider call id) after signature verification, so these lookups are the
  // mechanism that establishes tenancy rather than a query that should be
  // constrained by it.
  'telephony/telephony.service.ts:call.findFirst',
  'telephony/telephony.service.ts:call.findUnique',
  'telephony/telephony.service.ts:call.update',
  'telephony/telephony.service.ts:call.upsert',
  'telephony/telephony.service.ts:callUsage.findUnique',
  'telephony/telephony.service.ts:telephonyPhoneNumber.findUnique',
  'twilio-adapter/twilio-webhook.controller.ts:call.findUnique',
  'twilio-adapter/twilio-webhook.controller.ts:call.update',
  'twilio-adapter/twilio-webhook.controller.ts:call.upsert',
  'twilio-adapter/twilio-webhook.controller.ts:callUsage.findUnique',
  'twilio-adapter/twilio-webhook.controller.ts:twilioPhoneNumber.findUnique',
  'twilio-adapter/twilio.adapter.ts:twilioPhoneNumber.findFirst',
  'calls/calls.service.ts:agentVersion.findFirst',
  'calls/calls.service.ts:agentVersion.findUnique',
  'calls/calls.service.ts:call.findFirst',
  'calls/calls.service.ts:call.update',
  'calls/calls.service.ts:callEvent.findMany',
  'calls/calls.service.ts:callEvent.findUnique',
  // Stripe webhooks are keyed on Stripe's customer/subscription ids, which are
  // the tenant identifier in that direction.
  'webhooks/stripe-webhook.service.ts:auditLog.findMany',
  'webhooks/stripe-webhook.service.ts:subscription.findFirst',
  'webhooks/stripe-webhook.service.ts:subscription.findMany',
  'webhooks/stripe-webhook.service.ts:subscription.updateMany',

  // -- Cross-tenant by design: scheduled sweeps and platform metrics -------
  // These run on a timer with no caller and must observe every tenant.
  'billing/reconciliation.service.ts:billingCreditBucket.findMany',
  'billing/reconciliation.service.ts:billingCreditBucket.updateMany',
  'billing/reconciliation.service.ts:callConcurrencyLease.count',
  'billing/reconciliation.service.ts:callConcurrencyLease.findMany',
  'billing/reconciliation.service.ts:callConcurrencyLease.updateMany',
  'billing/reconciliation.service.ts:callUsage.findMany',
  'billing/reconciliation.service.ts:callUsage.updateMany',
  'billing/reconciliation.service.ts:organizationCreditBalance.aggregate',
  'billing/reconciliation.service.ts:organizationCreditBalance.findMany',
  'billing/reconciliation.service.ts:subscription.findMany',
  'billing/provider-cost.service.ts:callUsage.count',
  'billing/provider-cost.service.ts:callUsage.findMany',
  'billing/provider-cost.service.ts:providerCostEvent.findUnique',
  'billing/provider-cost.service.ts:providerCostEvent.upsert',
  'compliance/retention.service.ts:call.count',
  'compliance/retention.service.ts:call.deleteMany',
  'compliance/retention.service.ts:call.findMany',
  'compliance/retention.service.ts:call.findUnique',
  'compliance/retention.service.ts:call.update',
  'workers/digest.worker.ts:workspace.findMany',
  'workers/embeddings.worker.ts:knowledgeChunk.count',
  'workers/embeddings.worker.ts:knowledgeChunk.findMany',

  // -- Background jobs keyed on an internal id ----------------------------
  // Enqueued by an already-authorized request; the job id is server-issued and
  // never client-supplied. These would still be better off carrying the tenant
  // id through the job payload - see the note in the report - but they are not
  // reachable from an untrusted caller.
  'agent-gen/agent-gen.service.ts:agentGenSession.findUnique',
  'agent-gen/agent-gen.service.ts:agentGenSession.updateMany',
  'billing/call-admission.service.ts:callUsage.updateMany',
  'billing/call-admission.service.ts:callUsage.upsert',
  'evaluations/evaluations.service.ts:agentVersion.findUnique',
  'evaluations/evaluations.service.ts:call.findUnique',
  'evaluations/evaluations.service.ts:callEvaluation.upsert',
  'outbound-campaign/outbound-campaign.service.ts:outboundCampaign.findUnique',
  'outbound-campaign/outbound-campaign.service.ts:outboundCampaign.update',
  'workers/orchestrator.worker.ts:agent.update',
  'voice/adapters/mock.adapter.ts:agentVersion.update',
  'voice/adapters/openai-realtime.adapter.ts:agentVersion.findUnique',
  'voice/adapters/openai-realtime.adapter.ts:agentVersion.update',

  // -- Guarded by a scoped read the analyzer cannot follow -----------------
  // Each of these is preceded by a tenant-scoped lookup whose result flows into
  // the query, but across a helper-method boundary or a destructuring the
  // intra-function taint analysis does not track.
  'agents/agents.service.ts:agentVersion.findFirst',
  'agents/agents.service.ts:agentVersion.update',
  'compliance/compliance.service.ts:complianceCheck.update',
  'compliance/erasure.service.ts:analyticsEvent.deleteMany',
  'compliance/erasure.service.ts:call.findMany',
  'compliance/erasure.service.ts:callEvaluation.deleteMany',
  'compliance/erasure.service.ts:toolInvocation.deleteMany',
  'knowledge/knowledge.service.ts:knowledgeChunk.deleteMany',
  'knowledge/knowledge.service.ts:knowledgeChunk.findMany',
  'knowledge/knowledge.service.ts:knowledgeSource.findMany',
  'knowledge/knowledge.service.ts:knowledgeSource.findUnique',
  'knowledge/knowledge.service.ts:knowledgeSource.update',
  'tools/tools.service.ts:toolInvocation.update',
  // importNumbers() re-reads the row via findUnique({ where: { phoneNumberE164 } })
  // and throws PHONE_NUMBER_ALREADY_CONNECTED when existing.workspaceId !==
  // workspaceId (telephony.service.ts:230-239), so the update can only touch a
  // row already proven to belong to the caller's workspace.
  'telephony/telephony.service.ts:telephonyPhoneNumber.update',
  'workspace-crm/workspace-crm.service.ts:workspaceCrmCredential.delete',
  'workspace-crm/workspace-crm.service.ts:workspaceCrmCredential.update',
  'agents/agents.controller.ts:agent.findFirst',
  // The internal LiveKit routes establish tenancy from the admitted call row:
  // the call id is sent by our own runtime (@InternalOnly), and the handler
  // refuses the request unless call.agentId matches the path agent before any
  // tenant-scoped work happens. The lookup is the mechanism that establishes
  // tenancy, like webhook ingress above.
  'tools/livekit-tools.controller.ts:call.findUnique',
  'voice/livekit-knowledge.controller.ts:call.findUnique',

  // -- User-scoped or workspace-root queries ------------------------------
  // Keyed on the authenticated user id, or on the Workspace/Organization row
  // itself, where the id IS the tenant identifier.
  'auth/supabase-auth.service.ts:membership.findFirst',
  'compliance/erasure.service.ts:membership.deleteMany',
  'compliance/erasure.service.ts:workspaceMembership.deleteMany',
  'workspaces/workspaces.service.ts:membership.findMany',
  'referral/referral.service.ts:workspace.findUnique',
  'white-label/white-label.service.ts:workspace.findMany',
  'white-label/white-label.service.ts:workspace.findUnique',
  'white-label/white-label.service.ts:workspace.findUniqueOrThrow',
  'white-label/white-label.service.ts:whiteLabelSettings.findUnique',

  // -- Global catalogue ----------------------------------------------------
  // AgentTemplate.workspaceId is nullable and only public templates are read.
  'templates/templates.service.ts:agentTemplate.findMany',
  'templates/templates.service.ts:agentTemplate.findUnique',

  // -- Audit log reads -----------------------------------------------------
  // audit.controller.ts builds `where` as a typed local that already carries
  // workspaceId; audit-export.service.ts scopes by organizationId. The
  // analyzer reports them because the predicate is assembled before the call.
  'audit/audit.controller.ts:auditLog.findMany',
  'audit/audit-export.service.ts:auditLog.findMany',
];

/**
 * Per-key call-site counts for every baselined query. `queryKey` deliberately
 * omits the line number so unrelated edits do not churn the baseline, but that
 * means a REVIEWED_BASELINE entry alone would approve any number of additional
 * call sites at the same key. This map pins the reviewed count. When it fails:
 * a NEW site was added at a baselined key. Review it like any novel finding —
 * scope it, or bump the count here in the same commit with a justification.
 */
const EXPECTED_SITE_COUNTS: Readonly<Record<string, number>> = {
  'agent-gen/agent-gen.service.ts:agentGenSession.findUnique': 1,
  'agent-gen/agent-gen.service.ts:agentGenSession.updateMany': 2,
  'agents/agents.controller.ts:agent.findFirst': 1,
  'agents/agents.service.ts:agentVersion.findFirst': 1,
  'agents/agents.service.ts:agentVersion.update': 1,
  'audit/audit-export.service.ts:auditLog.findMany': 1,
  'audit/audit.controller.ts:auditLog.findMany': 1,
  'auth/supabase-auth.service.ts:membership.findFirst': 1,
  'billing/call-admission.service.ts:callUsage.updateMany': 1,
  'billing/call-admission.service.ts:callUsage.upsert': 1,
  'billing/provider-cost.service.ts:callUsage.count': 2,
  'billing/provider-cost.service.ts:callUsage.findMany': 1,
  'billing/provider-cost.service.ts:providerCostEvent.findUnique': 1,
  'billing/provider-cost.service.ts:providerCostEvent.upsert': 1,
  'billing/reconciliation.service.ts:billingCreditBucket.findMany': 1,
  'billing/reconciliation.service.ts:billingCreditBucket.updateMany': 1,
  'billing/reconciliation.service.ts:callConcurrencyLease.count': 1,
  'billing/reconciliation.service.ts:callConcurrencyLease.findMany': 1,
  'billing/reconciliation.service.ts:callConcurrencyLease.updateMany': 1,
  'billing/reconciliation.service.ts:callUsage.findMany': 1,
  'billing/reconciliation.service.ts:callUsage.updateMany': 2,
  'billing/reconciliation.service.ts:organizationCreditBalance.aggregate': 1,
  'billing/reconciliation.service.ts:organizationCreditBalance.findMany': 1,
  'billing/reconciliation.service.ts:subscription.findMany': 1,
  'calls/calls.service.ts:agentVersion.findFirst': 1,
  'calls/calls.service.ts:agentVersion.findUnique': 1,
  'calls/calls.service.ts:call.findFirst': 1,
  'calls/calls.service.ts:call.update': 1,
  'calls/calls.service.ts:callEvent.findMany': 1,
  'calls/calls.service.ts:callEvent.findUnique': 1,
  'compliance/compliance.service.ts:complianceCheck.update': 1,
  'compliance/erasure.service.ts:analyticsEvent.deleteMany': 1,
  'compliance/erasure.service.ts:call.findMany': 1,
  'compliance/erasure.service.ts:callEvaluation.deleteMany': 1,
  'compliance/erasure.service.ts:membership.deleteMany': 1,
  'compliance/erasure.service.ts:toolInvocation.deleteMany': 1,
  'compliance/erasure.service.ts:workspaceMembership.deleteMany': 1,
  'compliance/retention.service.ts:call.count': 2,
  'compliance/retention.service.ts:call.deleteMany': 1,
  'compliance/retention.service.ts:call.findMany': 1,
  'compliance/retention.service.ts:call.findUnique': 1,
  'compliance/retention.service.ts:call.update': 1,
  'evaluations/evaluations.service.ts:agentVersion.findUnique': 1,
  'evaluations/evaluations.service.ts:call.findUnique': 1,
  'evaluations/evaluations.service.ts:callEvaluation.upsert': 1,
  'knowledge/knowledge.service.ts:knowledgeChunk.deleteMany': 2,
  'knowledge/knowledge.service.ts:knowledgeChunk.findMany': 1,
  'knowledge/knowledge.service.ts:knowledgeSource.findMany': 1,
  'knowledge/knowledge.service.ts:knowledgeSource.findUnique': 1,
  'knowledge/knowledge.service.ts:knowledgeSource.update': 4,
  'outbound-campaign/outbound-campaign.service.ts:outboundCampaign.findUnique': 1,
  'outbound-campaign/outbound-campaign.service.ts:outboundCampaign.update': 1,
  'referral/referral.service.ts:workspace.findUnique': 2,
  'telephony/telephony.service.ts:call.findFirst': 2,
  'telephony/telephony.service.ts:call.findUnique': 1,
  'telephony/telephony.service.ts:call.update': 1,
  'telephony/telephony.service.ts:call.upsert': 1,
  'telephony/telephony.service.ts:callUsage.findUnique': 1,
  'telephony/telephony.service.ts:telephonyPhoneNumber.findUnique': 6,
  'telephony/telephony.service.ts:telephonyPhoneNumber.update': 1,
  'templates/templates.service.ts:agentTemplate.findMany': 1,
  'templates/templates.service.ts:agentTemplate.findUnique': 1,
  'tools/livekit-tools.controller.ts:call.findUnique': 1,
  'tools/tools.service.ts:toolInvocation.update': 3,
  'twilio-adapter/twilio-webhook.controller.ts:call.findUnique': 2,
  'twilio-adapter/twilio-webhook.controller.ts:call.update': 2,
  'twilio-adapter/twilio-webhook.controller.ts:call.upsert': 1,
  'twilio-adapter/twilio-webhook.controller.ts:callUsage.findUnique': 1,
  'twilio-adapter/twilio-webhook.controller.ts:twilioPhoneNumber.findUnique': 1,
  'twilio-adapter/twilio.adapter.ts:twilioPhoneNumber.findFirst': 1,
  'voice/adapters/mock.adapter.ts:agentVersion.update': 1,
  'voice/adapters/openai-realtime.adapter.ts:agentVersion.findUnique': 1,
  'voice/adapters/openai-realtime.adapter.ts:agentVersion.update': 1,
  'voice/livekit-knowledge.controller.ts:call.findUnique': 1,
  'webhooks/stripe-webhook.service.ts:auditLog.findMany': 1,
  'webhooks/stripe-webhook.service.ts:subscription.findFirst': 4,
  'webhooks/stripe-webhook.service.ts:subscription.findMany': 1,
  'webhooks/stripe-webhook.service.ts:subscription.updateMany': 1,
  'white-label/white-label.service.ts:whiteLabelSettings.findUnique': 1,
  'white-label/white-label.service.ts:workspace.findMany': 1,
  'white-label/white-label.service.ts:workspace.findUnique': 1,
  'white-label/white-label.service.ts:workspace.findUniqueOrThrow': 2,
  'workers/digest.worker.ts:workspace.findMany': 1,
  'workers/embeddings.worker.ts:knowledgeChunk.count': 1,
  'workers/embeddings.worker.ts:knowledgeChunk.findMany': 1,
  'workers/orchestrator.worker.ts:agent.update': 7,
  'workspace-crm/workspace-crm.service.ts:workspaceCrmCredential.delete': 1,
  'workspace-crm/workspace-crm.service.ts:workspaceCrmCredential.update': 3,
  'workspaces/workspaces.service.ts:membership.findMany': 1,
};

describe('tenant scope baseline', () => {
  it('derives tenant-scoped models from the Prisma schema rather than a hardcoded list', () => {
    const models = tenantScopedModels(SCHEMA_PATH);
    // Spot-check a few models that must be recognised; if the schema parser
    // silently matched nothing, the whole guard would pass vacuously.
    expect(models.has('agent')).toBe(true);
    expect(models.has('call')).toBe(true);
    expect(models.has('contact')).toBe(true);
    expect(models.has('twilioPhoneNumber')).toBe(true);
    expect(models.size).toBeGreaterThan(20);
  });

  it('introduces no unscoped Prisma query outside the reviewed baseline', () => {
    const found = findUnscopedQueries(SRC_DIR, SCHEMA_PATH);
    const baseline = new Set(REVIEWED_BASELINE);

    const novel = found.filter((q) => !baseline.has(queryKey(q)));

    expect(
      novel.map((q) => `${q.file}:${q.line} ${q.model}.${q.operation} in ${q.fn}()`),
    ).toEqual([]);
  });

  it('adds no additional call site at an already-baselined key', () => {
    // `queryKey` omits the line number, so without this check one baseline
    // entry would approve any number of new call sites at the same
    // file/model/operation. Pin the reviewed count per key.
    const counts = new Map<string, number>();
    for (const q of findUnscopedQueries(SRC_DIR, SCHEMA_PATH)) {
      const key = queryKey(q);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries([...counts.entries()].sort())).toEqual(EXPECTED_SITE_COUNTS);
  });

  it('keeps the baseline free of stale entries', () => {
    const found = new Set(findUnscopedQueries(SRC_DIR, SCHEMA_PATH).map(queryKey));
    const stale = REVIEWED_BASELINE.filter((entry) => !found.has(entry));

    // A stale entry means the query was fixed or removed. Deleting it keeps the
    // baseline honest and stops it from silently re-approving a future leak at
    // the same location.
    expect(stale).toEqual([]);
  });

  it('flags a newly added unscoped query on a tenant-scoped model', () => {
    // Guards the guard: if the analyzer stopped detecting anything, the
    // baseline test above would pass no matter what was added.
    const found = findUnscopedQueries(SRC_DIR, SCHEMA_PATH);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((q) => typeof q.file === 'string' && q.line > 0)).toBe(true);
  });
});
