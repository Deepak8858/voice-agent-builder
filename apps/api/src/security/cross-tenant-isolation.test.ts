import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePrisma, type FakePrisma } from './tenant-fake-prisma';
import { PhoneNumbersService } from '../phone-numbers/phone-numbers.service';
import { ComplianceService } from '../compliance/compliance.service';
import { CrmFanOutService } from '../crm-routing/crm-fanout.service';
import { CrmRoutingService } from '../crm-routing/crm-routing.service';
import { AgentOrchestratorService } from '../orchestrator/orchestrator.service';
import { OutboundCampaignService } from '../outbound-campaign/outbound-campaign.service';
import { WorkspaceCrmService } from '../workspace-crm/workspace-crm.service';
import { ToolsService } from '../tools/tools.service';

/**
 * Cross-tenant authorization sweep.
 *
 * Tenant isolation in this codebase is enforced entirely in application code:
 * the Prisma connection is privileged and there is no row-level security and no
 * shared scoping helper, so a single missing `where: { workspaceId }` is a
 * cross-tenant leak.
 *
 * Every test here follows the same shape: seed ONE row in workspace A and ONE
 * row in workspace B, then call the service as workspace A asking for
 * workspace B's id. Because the fake Prisma actually evaluates the `where`
 * clause (see tenant-fake-prisma.ts), a service that drops the tenant predicate
 * really does receive the foreign row, and the assertion really does fail.
 *
 * Tests are grouped by the leak shape they defend against, so a future reader
 * can tell which class of bug a failure represents.
 */

const WS_A = 'ws-aaaaaaaa';
const WS_B = 'ws-bbbbbbbb';

// Real, parseable US numbers: ComplianceService normalizes through
// libphonenumber and discards anything that fails validation, so placeholder
// 555 numbers would short-circuit the rules under test.
const PHONE_A = '+12125550111';
const PHONE_B = '+13105550122';

const noopAudit = () => ({ log: vi.fn(async () => undefined) });

describe('cross-tenant isolation: phone numbers (bare-id update/delete)', () => {
  let prisma: FakePrisma;
  let service: PhoneNumbersService;

  beforeEach(() => {
    prisma = createFakePrisma({
      twilioPhoneNumber: [
        { id: 'num-a', workspaceId: WS_A, agentId: null, type: 'byo', twilioSid: null, phoneNumber: '+15550001' },
        { id: 'num-b', workspaceId: WS_B, agentId: null, type: 'byo', twilioSid: null, phoneNumber: '+15550002' },
      ],
      agent: [
        { id: 'agent-a', workspaceId: WS_A, name: 'A' },
        { id: 'agent-b', workspaceId: WS_B, name: 'B' },
      ],
    });
    service = new PhoneNumbersService(prisma as never, noopAudit() as never);
  });

  it('lists only the calling workspace numbers', async () => {
    const rows = await service.list(WS_A);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['num-a']);
  });

  it('refuses to reassign a phone number owned by another workspace', async () => {
    await expect(service.assignToAgent(WS_A, 'num-b', 'agent-a')).rejects.toMatchObject({
      errorCode: 'NOT_FOUND',
    });
    // The victim row must be untouched.
    const victim = prisma.rowsOf('twilioPhoneNumber').find((r) => r['id'] === 'num-b');
    expect(victim?.['agentId']).toBeNull();
  });

  it('refuses to point a phone number at an agent owned by another workspace', async () => {
    await expect(service.assignToAgent(WS_A, 'num-a', 'agent-b')).rejects.toMatchObject({
      errorCode: 'NOT_FOUND',
    });
    const own = prisma.rowsOf('twilioPhoneNumber').find((r) => r['id'] === 'num-a');
    expect(own?.['agentId']).toBeNull();
  });

  /**
   * `provision` accepts the same client-supplied agent id as `assignToAgent`
   * but used to write it straight to `twilioPhoneNumber.create`, so the check
   * above could be bypassed simply by attaching the foreign agent at purchase
   * time instead of afterwards. The rejection must also happen before the
   * Twilio purchase, or the workspace is billed for a number that is then
   * refused.
   */
  it('refuses to provision a number attached to an agent owned by another workspace', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(service.provision(WS_A, '212', 'agent-b')).rejects.toMatchObject({
      errorCode: 'NOT_FOUND',
    });

    // No number was bought and no row was written.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.rowsOf('twilioPhoneNumber').map((r) => r['id'])).toEqual(['num-a', 'num-b']);

    fetchSpy.mockRestore();
  });

  it('refuses to release (delete) a phone number owned by another workspace', async () => {
    await service.release(WS_A, 'num-b');
    expect(prisma.rowsOf('twilioPhoneNumber').map((r) => r['id'])).toContain('num-b');
  });

  it('still performs the legitimate same-workspace assign and release', async () => {
    await service.assignToAgent(WS_A, 'num-a', 'agent-a');
    expect(prisma.rowsOf('twilioPhoneNumber').find((r) => r['id'] === 'num-a')?.['agentId']).toBe('agent-a');

    await service.release(WS_A, 'num-a');
    expect(prisma.rowsOf('twilioPhoneNumber').map((r) => r['id'])).toEqual(['num-b']);
  });
});

describe('cross-tenant isolation: compliance check (client-supplied contact id)', () => {
  /**
   * `contactId` reaches ComplianceService.check() straight from the request
   * body (`dto.contact_id`). If the opt-out / consent lookups are not scoped,
   * an attacker can make this workspace's compliance decision depend on
   * another tenant's contact - either bypassing an opt-out or forging consent.
   */
  const spec = { compliance: { consent_required_for_outbound: true } };

  function makeService(seedOverrides: Record<string, Record<string, unknown>[]> = {}) {
    const prisma = createFakePrisma({
      agent: [
        {
          id: 'agent-a',
          workspaceId: WS_A,
          status: 'published',
          versions: [{ specJson: spec }],
        },
      ],
      contact: [
        // Workspace A's contact has opted OUT.
        { id: 'contact-a', workspaceId: WS_A, phone: PHONE_A, optOut: true },
        // Workspace B's contact has NOT opted out and holds valid consent.
        { id: 'contact-b', workspaceId: WS_B, phone: PHONE_B, optOut: false },
      ],
      consentRecord: [
        {
          id: 'consent-b',
          workspaceId: WS_B,
          contactId: 'contact-b',
          consentType: 'outbound_marketing',
          revokedAt: null,
          expiresAt: null,
        },
      ],
      dncEntry: [],
      complianceCheck: [],
      ...seedOverrides,
    });
    (prisma as unknown as { organizationIdFor: unknown }).organizationIdFor = async () => 'org-a';
    return {
      prisma,
      service: new ComplianceService(prisma as never, noopAudit() as never),
    };
  }

  it('does not accept another workspace consent record when the caller supplies a foreign contact id', async () => {
    const { prisma, service } = makeService();

    const result = await service.check({
      workspaceId: WS_A,
      agentId: 'agent-a',
      direction: 'outbound',
      toNumber: PHONE_B,
      contactId: 'contact-b',
    });

    // contact-b is invisible to workspace A, so consent cannot be verified.
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('missing_consent');

    // The unresolved foreign id must not be echoed back...
    expect(result.contact_id).toBeNull();
    // ...nor persisted onto this workspace's ComplianceCheck row, which would
    // both leak the existence of contact-b and corrupt workspace A's records.
    const persisted = prisma.rowsOf('complianceCheck');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.['contactId']).toBeNull();
    expect(persisted[0]?.['workspaceId']).toBe(WS_A);
  });

  it('scopes every contact and consent lookup to the calling workspace', async () => {
    const { prisma, service } = makeService();

    await service.check({
      workspaceId: WS_A,
      agentId: 'agent-a',
      direction: 'outbound',
      toNumber: PHONE_B,
      contactId: 'contact-b',
    });

    const unscoped = prisma.calls.filter(
      (call) =>
        (call.model === 'contact' || call.model === 'consentRecord') &&
        call.operation !== 'create' &&
        !JSON.stringify(call.where ?? {}).includes(WS_A),
    );
    expect(unscoped).toEqual([]);
  });

  it('still blocks its own opted-out contact (the rule is not simply disabled)', async () => {
    const { service } = makeService();

    const result = await service.check({
      workspaceId: WS_A,
      agentId: 'agent-a',
      direction: 'outbound',
      toNumber: PHONE_A,
      contactId: 'contact-a',
    });

    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('opted_out');
  });

  /**
   * Same-tenant variant of the same bug, which workspace scoping alone cannot
   * catch. Both contacts belong to workspace A, so the scoped lookup happily
   * returned the *supplied* contact and evaluated its opt-out and consent
   * state - even though a different contact's number was being dialled. The
   * dialled number, not the supplied id, has to select the contact.
   */
  it('evaluates the contact behind the dialled number, not a mismatched supplied contact id', async () => {
    const { prisma, service } = makeService({
      contact: [
        // The number actually being dialled belongs to someone who opted out.
        { id: 'contact-optout', workspaceId: WS_A, phone: PHONE_A, optOut: true },
        // A different, consented contact in the SAME workspace.
        { id: 'contact-consented', workspaceId: WS_A, phone: PHONE_B, optOut: false },
      ],
      consentRecord: [
        {
          id: 'consent-consented',
          workspaceId: WS_A,
          contactId: 'contact-consented',
          consentType: 'outbound_marketing',
          revokedAt: null,
          expiresAt: null,
        },
      ],
    });

    const result = await service.check({
      workspaceId: WS_A,
      agentId: 'agent-a',
      direction: 'outbound',
      // Dialling the opted-out person...
      toNumber: PHONE_A,
      // ...while claiming the consented contact's id.
      contactId: 'contact-consented',
    });

    // The opt-out on the dialled number must still block the call.
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('opted_out');

    // And the check must be recorded against the person actually being called,
    // never the id the caller asked us to use.
    expect(result.contact_id).toBe('contact-optout');
    expect(prisma.rowsOf('complianceCheck')[0]?.['contactId']).toBe('contact-optout');
  });
});

describe('cross-tenant isolation: CRM fan-out (transcript read by bare call id)', () => {
  it('does not read another workspace call transcript when routing', async () => {
    const prisma = createFakePrisma({
      call: [
        { id: 'call-a', workspaceId: WS_A, transcriptText: 'hello' },
        { id: 'call-b', workspaceId: WS_B, transcriptText: 'dental implant enquiry' },
      ],
      crmRoutingRule: [
        {
          id: 'rule-a',
          workspaceId: WS_A,
          agentId: 'agent-a',
          keyword: 'dental',
          provider: 'pipedrive',
          action: 'primary',
          priority: 1,
          active: true,
        },
      ],
      workspaceCrmCredential: [],
      crmFanoutLog: [],
    });

    const routing = new CrmRoutingService(prisma as never, { log: vi.fn() } as never);
    const crmExecutor = { createContact: vi.fn() };
    const encryption = { decryptJson: vi.fn(), encryptJson: vi.fn() };
    const service = new CrmFanOutService(
      prisma as never,
      routing as never,
      crmExecutor as never,
      encryption as never,
    );

    const result = await service.fanOutContact(WS_A, 'agent-a', 'call-b', { full_name: 'Someone' });

    // Workspace B's transcript contains the "dental" keyword. If it leaked, the
    // rule would match and a CRM contact would be created.
    expect(result.errors).toContain('No matching CRM routing rules');
    expect(crmExecutor.createContact).not.toHaveBeenCalled();
  });

  it('matches the rule when the call genuinely belongs to the caller workspace', async () => {
    const prisma = createFakePrisma({
      call: [{ id: 'call-a', workspaceId: WS_A, transcriptText: 'dental implant enquiry' }],
      crmRoutingRule: [
        {
          id: 'rule-a',
          workspaceId: WS_A,
          agentId: 'agent-a',
          keyword: 'dental',
          provider: 'pipedrive',
          action: 'primary',
          priority: 1,
          active: true,
        },
      ],
      workspaceCrmCredential: [
        {
          id: 'cred-a',
          workspaceId: WS_A,
          provider: 'pipedrive',
          status: 'active',
          credentials: { api_key: 'k' },
        },
      ],
      crmFanoutLog: [],
    });

    const routing = new CrmRoutingService(prisma as never, { log: vi.fn() } as never);
    const crmExecutor = {
      createContact: vi.fn(async () => ({ contact_id: 'c1', status: 'created', provider: 'pipedrive' })),
    };
    const encryption = { decryptJson: vi.fn(), encryptJson: vi.fn() };
    const service = new CrmFanOutService(
      prisma as never,
      routing as never,
      crmExecutor as never,
      encryption as never,
    );

    const result = await service.fanOutContact(WS_A, 'agent-a', 'call-a', { full_name: 'Someone' });
    expect(result.primary).toMatchObject({ contact_id: 'c1' });

    // The audit row must carry its own tenant column. call_id/agent_id are both
    // ON DELETE SET NULL, so without this the row becomes unattributable the
    // moment the call or agent is deleted.
    expect(prisma.rowsOf('crmFanoutLog')[0]?.['workspaceId']).toBe(WS_A);
  });
});

describe('cross-tenant isolation: orchestrator publish (bare agent id)', () => {
  function makeService() {
    const prisma = createFakePrisma({
      agent: [
        { id: 'agent-a', workspaceId: WS_A, status: 'draft', versions: [] },
        { id: 'agent-b', workspaceId: WS_B, status: 'draft', versions: [] },
      ],
      knowledgeSource: [{ id: 'ks-b', workspaceId: WS_B, agentId: 'agent-b', status: 'ready' }],
      crmRoutingRule: [{ id: 'rule-b', workspaceId: WS_B, agentId: 'agent-b', provider: 'hubspot' }],
      twilioPhoneNumber: [{ id: 'num-b', workspaceId: WS_B, agentId: 'agent-b', phoneNumber: '+15550002' }],
    });
    const queue = { enqueue: vi.fn(async () => undefined) };
    return {
      prisma,
      queue,
      service: new AgentOrchestratorService(prisma as never, queue as never, noopAudit() as never),
    };
  }

  it('does not publish an agent owned by another workspace', async () => {
    const { prisma, queue, service } = makeService();

    await expect(service.publish(WS_A, 'agent-b', 'user-a')).rejects.toThrow();

    expect(prisma.rowsOf('agent').find((r) => r['id'] === 'agent-b')?.['status']).toBe('draft');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('publishes the caller own agent', async () => {
    const { prisma, queue, service } = makeService();

    await service.publish(WS_A, 'agent-a', 'user-a');

    expect(prisma.rowsOf('agent').find((r) => r['id'] === 'agent-a')?.['status']).toBe('publishing');
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it('does not surface another workspace knowledge sources, rules or numbers in generation status', async () => {
    const { service } = makeService();

    // agent-b belongs to WS_B, so asking as WS_A must not resolve at all.
    await expect(service.getStatus(WS_A, 'agent-b')).rejects.toThrow('Agent not found');
  });

  it('builds generation steps only from the caller workspace related rows', async () => {
    const prisma = createFakePrisma({
      agent: [{ id: 'agent-a', workspaceId: WS_A, status: 'draft', versions: [], createdAt: new Date(), updatedAt: new Date() }],
      // These related rows all reference agent-a's id but belong to WS_B.
      // A query keyed only on agentId would wrongly pick them up.
      knowledgeSource: [{ id: 'ks-b', workspaceId: WS_B, agentId: 'agent-a', status: 'ready' }],
      crmRoutingRule: [{ id: 'rule-b', workspaceId: WS_B, agentId: 'agent-a', provider: 'hubspot' }],
      twilioPhoneNumber: [{ id: 'num-b', workspaceId: WS_B, agentId: 'agent-a', phoneNumber: '+15550002' }],
    });
    const queue = { enqueue: vi.fn(async () => undefined) };
    const service = new AgentOrchestratorService(prisma as never, queue as never, noopAudit() as never);

    const status = await service.getStatus(WS_A, 'agent-a');

    expect(status.steps.doc_ingest.total).toBe(0);
    expect(status.steps.crm_setup.providers).toEqual([]);
    expect(status.steps.phone_number.number).toBeUndefined();
  });
});

describe('cross-tenant isolation: already-correct services (regression guards)', () => {
  /**
   * These services scope correctly today. The tests exist so that a future
   * refactor that drops the predicate fails here rather than in production.
   */

  it('OutboundCampaignService does not start, pause or read another workspace campaign', async () => {
    const prisma = createFakePrisma({
      outboundCampaign: [
        { id: 'camp-a', workspaceId: WS_A, agentId: 'agent-a', status: 'draft', contacts: [], stats: {} },
        { id: 'camp-b', workspaceId: WS_B, agentId: 'agent-b', status: 'draft', contacts: [], stats: {} },
      ],
    });
    const queue = { enqueue: vi.fn(async () => undefined) };
    const service = new OutboundCampaignService(
      prisma as never,
      queue as never,
      noopAudit() as never,
    );

    await expect(service.start(WS_A, 'camp-b', 'user-a')).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    await expect(service.pause(WS_A, 'camp-b', 'user-a')).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    await expect(service.getCampaign(WS_A, 'camp-b')).resolves.toBeNull();
    expect(prisma.rowsOf('outboundCampaign').find((r) => r['id'] === 'camp-b')?.['status']).toBe('draft');
  });

  it('WorkspaceCrmService does not read, update or delete another workspace credential', async () => {
    const prisma = createFakePrisma({
      workspaceCrmCredential: [
        { id: 'cred-a', workspaceId: WS_A, provider: 'hubspot', status: 'active', credentials: {} },
        { id: 'cred-b', workspaceId: WS_B, provider: 'hubspot', status: 'active', credentials: {} },
      ],
    });
    const service = new WorkspaceCrmService(
      prisma as never,
      { createContact: vi.fn() } as never,
      { encryptJson: vi.fn(), decryptJson: vi.fn(() => ({})) } as never,
      noopAudit() as never,
    );

    await expect(service.update(WS_A, 'cred-b', 'user-a', { status: 'active' })).rejects.toMatchObject({
      errorCode: 'NOT_FOUND',
    });
    await expect(service.delete(WS_A, 'cred-b', 'user-a')).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(prisma.rowsOf('workspaceCrmCredential')).toHaveLength(2);
  });

  it('ToolsService does not read, update or delete another workspace tool', async () => {
    const prisma = createFakePrisma({
      integrationTool: [
        { id: 'tool-a', workspaceId: WS_A, name: 'a', toolId: 'a', enabled: true },
        { id: 'tool-b', workspaceId: WS_B, name: 'b', toolId: 'b', enabled: true },
      ],
    });
    const executor = (name: string) => ({ name, execute: vi.fn() });
    const service = new ToolsService(
      prisma as never,
      noopAudit() as never,
      executor('webhook') as never,
      executor('google_calendar') as never,
      executor('gmail') as never,
      executor('sheets') as never,
      // Required since the fail-open entitlement guards were deleted: an absent
      // billing/compliance dependency is no longer silently permissive. This
      // test only calls `get`, so none of the three is exercised.
      { createContact: vi.fn() } as never,
      { checkFeatureGate: vi.fn(async () => true) } as never,
      { checkOutboundEmail: vi.fn() } as never,
    );

    await expect(service.get(WS_A, 'tool-b')).rejects.toMatchObject({ errorCode: 'TOOL_NOT_FOUND' });
    expect(prisma.rowsOf('integrationTool')).toHaveLength(2);
  });
});
