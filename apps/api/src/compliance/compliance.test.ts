import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import { ComplianceService, normalizePhone } from './compliance.service';

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schema_version: '1.0',
    name: 'Test Agent',
    industry: 'dental',
    agent_type: 'outbound_reminder',
    language: 'en',
    voice: { tone: 'warm', allow_interruptions: true },
    identity: { business_name: 'Acme', agent_name: 'Ava', disclosure: 'I am an AI.' },
    goals: ['confirm appointment'],
    required_fields: [],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
    tools: [],
    handoff: { enabled: true, conditions: ['emergency'] },
    compliance: {
      ai_disclosure_required: true,
      recording_notice_required: false,
      opt_out_enabled: true,
      consent_required_for_outbound: true,
    },
    analytics: { success_events: [] },
    ...overrides,
  } as AgentSpec;
}

interface AgentRow {
  id: string;
  workspaceId: string;
  status: string;
  versions: Array<{ specJson: AgentSpec }>;
}

interface State {
  agent: AgentRow | null;
  contactByPhone: Map<string, { id: string; optOut: boolean }>;
  contactById: Map<string, { id: string; optOut: boolean }>;
  consentByContact: Map<string, Array<{ consentType: string; revokedAt: Date | null; expiresAt: Date | null }>>;
  dnc: Set<string>;
  checks: Array<{ id: string; status: string; reasons: unknown }>;
}

function makePrisma(state: State) {
  let nextId = 1;
  return {
    organizationIdFor: vi.fn(async () => 'org-1'),
    agent: {
      findFirst: vi.fn(async () => state.agent),
    },
    contact: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; workspaceId_phone?: { phone: string } } }) => {
          if (where.id) return state.contactById.get(where.id) ?? null;
          if (where.workspaceId_phone) {
            return state.contactByPhone.get(where.workspaceId_phone.phone) ?? null;
          }
          return null;
        },
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; workspaceId_phone?: { phone: string } } }) => {
          if (where.id) return state.contactById.get(where.id) ?? null;
          return null;
        },
      ),
      create: vi.fn(async ({ data }: { data: { workspaceId: string; phone: string } }) => {
        const id = `contact-${nextId++}`;
        const row = { id, optOut: false, ...data };
        state.contactByPhone.set(data.phone, row);
        state.contactById.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { optOut?: boolean } }) => {
        const row = state.contactById.get(where.id);
        if (!row) return null;
        if (data.optOut !== undefined) row.optOut = data.optOut;
        return row;
      }),
    },
    consentRecord: {
      findFirst: vi.fn(async ({ where }: { where: { contactId: string } }) => {
        const list = state.consentByContact.get(where.contactId) ?? [];
        return list.find((c) => c.revokedAt === null && (c.expiresAt === null || c.expiresAt > new Date())) ?? null;
      }),
    },
    dncEntry: {
      findUnique: vi.fn(
        async ({ where }: { where: { workspaceId_phone: { phone: string } } }) =>
          state.dnc.has(where.workspaceId_phone.phone)
            ? { id: 'dnc-1', source: 'manual' }
            : null,
      ),
      upsert: vi.fn(async ({ where }: { where: { workspaceId_phone: { phone: string } } }) => {
        state.dnc.add(where.workspaceId_phone.phone);
        return { id: 'dnc-up', source: 'request' };
      }),
    },
    complianceCheck: {
      create: vi.fn(async ({ data }: { data: { status: string; reasons: unknown } }) => {
        const id = `check-${nextId++}`;
        const row = {
          id,
          status: data.status,
          reasons: data.reasons,
          agentId: state.agent!.id,
          contactId: null,
          callId: null,
          direction: 'outbound',
          checkedAt: new Date('2026-04-27T12:00:00Z'),
        };
        state.checks.push({ id, status: data.status, reasons: data.reasons });
        return row;
      }),
    },
  };
}

const audit = { log: vi.fn(async () => undefined) } as unknown as { log: () => Promise<void> };

function makeService(state: State) {
  const prisma = makePrisma(state);
  return new ComplianceService(prisma as never, audit as never);
}

function defaultState(overrides: Partial<State> = {}): State {
  return {
    agent: {
      id: 'agent-1',
      workspaceId: 'ws-1',
      status: 'published',
      versions: [{ specJson: spec() }],
    },
    contactByPhone: new Map(),
    contactById: new Map(),
    consentByContact: new Map(),
    dnc: new Set(),
    checks: [],
    ...overrides,
  };
}

describe('ComplianceService.check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks outbound when agent is not published', async () => {
    const state = defaultState();
    state.agent!.status = 'draft';
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: '+15551234567',
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('agent_not_published');
  });

  it('blocks outbound on DNC-listed number', async () => {
    const state = defaultState();
    state.dnc.add('+15550009999');
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: '+1 555 000 9999',
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('dnc_listed');
  });

  it('blocks outbound when contact opted out', async () => {
    const state = defaultState();
    const phone = '+15551112222';
    state.contactByPhone.set(phone, { id: 'c1', optOut: true });
    state.contactById.set('c1', { id: 'c1', optOut: true });
    state.consentByContact.set('c1', [
      { consentType: 'outbound_marketing', revokedAt: null, expiresAt: null },
    ]);
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: phone,
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('opted_out');
  });

  it('blocks outbound when consent required and missing', async () => {
    const state = defaultState();
    const phone = '+15553334444';
    state.contactByPhone.set(phone, { id: 'c2', optOut: false });
    state.contactById.set('c2', { id: 'c2', optOut: false });
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: phone,
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('missing_consent');
  });

  it('blocks unsupported outbound purpose', async () => {
    const state = defaultState();
    const phone = '+15554445555';
    state.contactByPhone.set(phone, { id: 'c3', optOut: false });
    state.contactById.set('c3', { id: 'c3', optOut: false });
    state.consentByContact.set('c3', [
      { consentType: 'outbound_transactional', revokedAt: null, expiresAt: null },
    ]);
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: phone,
      purpose: 'cold_sales',
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('unsupported_purpose');
  });

  it('blocks outbound outside allowed call window', async () => {
    const state = defaultState();
    const phone = '+15555556666';
    state.contactByPhone.set(phone, { id: 'c4', optOut: false });
    state.contactById.set('c4', { id: 'c4', optOut: false });
    state.consentByContact.set('c4', [
      { consentType: 'outbound_transactional', revokedAt: null, expiresAt: null },
    ]);
    state.agent!.versions[0].specJson = spec({
      compliance: {
        ai_disclosure_required: true,
        recording_notice_required: false,
        opt_out_enabled: true,
        consent_required_for_outbound: true,
        // 99 is unreachable so check always fails closed.
        allowed_call_window: { timezone: 'UTC', start_hour: 99, end_hour: 99 },
      },
    });
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: phone,
      purpose: 'appointment_reminder',
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons.map((r) => r.code)).toContain('outside_call_window');
  });

  it('passes when all preconditions met', async () => {
    const state = defaultState();
    const phone = '+15557778888';
    state.contactByPhone.set(phone, { id: 'c5', optOut: false });
    state.contactById.set('c5', { id: 'c5', optOut: false });
    state.consentByContact.set('c5', [
      { consentType: 'outbound_transactional', revokedAt: null, expiresAt: null },
    ]);
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: phone,
      purpose: 'appointment_reminder',
    });
    expect(result.status).toBe('passed');
    expect(result.reasons.filter((r) => r.severity === 'blocking')).toHaveLength(0);
  });

  it('emits warning when AI disclosure required but missing', async () => {
    const state = defaultState();
    state.agent!.versions[0].specJson = spec({
      identity: { business_name: 'Acme', agent_name: 'Ava' },
    });
    const phone = '+15558889999';
    state.contactByPhone.set(phone, { id: 'c6', optOut: false });
    state.contactById.set('c6', { id: 'c6', optOut: false });
    state.consentByContact.set('c6', [
      { consentType: 'outbound_transactional', revokedAt: null, expiresAt: null },
    ]);
    const svc = makeService(state);
    const result = await svc.check({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
      toNumber: phone,
      purpose: 'appointment_reminder',
    });
    expect(result.status).toBe('passed'); // warnings do not block
    expect(result.reasons.find((r) => r.code === 'missing_ai_disclosure')?.severity).toBe('warning');
  });
});

describe('normalizePhone', () => {
  it('strips formatting', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('555.123.4567')).toBe('5551234567');
  });
});

describe('ComplianceService.processTranscriptOptOut', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flips contact opt_out and adds DNC when transcript matches', async () => {
    const state = defaultState();
    state.contactByPhone.set('+15551112222', { id: 'c-opt', optOut: false });
    state.contactById.set('c-opt', { id: 'c-opt', optOut: false });
    const svc = makeService(state);
    const result = await svc.processTranscriptOptOut({
      workspaceId: 'ws-1',
      callId: 'call-1',
      direction: 'inbound',
      contactId: null,
      fromNumber: '+1-555-111-2222',
      toNumber: null,
      transcript: 'caller: please do not call me again. agent: noted, goodbye.',
    });
    expect(result.opted_out).toBe(true);
    expect(result.matched_phrase).toBe('do not call');
    expect(state.contactById.get('c-opt')?.optOut).toBe(true);
    expect(state.dnc.has('+15551112222')).toBe(true);
  });

  it('no-op when transcript has no opt-out phrase', async () => {
    const state = defaultState();
    const svc = makeService(state);
    const result = await svc.processTranscriptOptOut({
      workspaceId: 'ws-1',
      callId: 'call-2',
      direction: 'outbound',
      contactId: null,
      fromNumber: null,
      toNumber: '+15551234567',
      transcript: 'caller: thanks, sounds good.',
    });
    expect(result.opted_out).toBe(false);
    expect(state.dnc.size).toBe(0);
  });
});
