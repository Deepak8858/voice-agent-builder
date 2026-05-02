import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics.service';

interface CallRow {
  id: string;
  status: string;
  durationSeconds: number | null;
  outcome: string | null;
  agentId: string;
  direction: string;
  createdAt: Date;
}

interface ToolRow {
  status: string;
  agentId: string;
  startedAt: Date;
}

interface EvalRow {
  agentId: string;
  overallScore: number;
  createdAt: Date;
}

interface ComplianceRow {
  agentId: string;
  status: string;
  reasons: Array<{ code?: string }>;
  checkedAt: Date;
}

interface ContactRow {
  id: string;
  optOut: boolean;
  optOutAt: Date | null;
}

interface AgentRow {
  id: string;
  name: string;
}

interface EventRow {
  id: string;
  workspaceId: string;
  agentId: string | null;
  callId: string | null;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
}

function inRange(d: Date, gte?: Date, lte?: Date): boolean {
  if (gte && d < gte) return false;
  if (lte && d > lte) return false;
  return true;
}

function makePrisma(state: {
  calls: CallRow[];
  tools: ToolRow[];
  evals: EvalRow[];
  compliance: ComplianceRow[];
  contacts: ContactRow[];
  agents: AgentRow[];
  events: EventRow[];
}) {
  return {
    organizationIdFor: vi.fn(async () => 'org-1'),
    analyticsEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: EventRow = {
          id: `evt-${state.events.length + 1}`,
          workspaceId: (data.workspaceId as string) ?? 'ws-1',
          agentId: (data.agentId as string | null) ?? null,
          callId: (data.callId as string | null) ?? null,
          eventType: data.eventType as string,
          payload: data.payload ?? null,
          occurredAt: (data.occurredAt as Date) ?? new Date('2026-04-27T10:00:00Z'),
        };
        state.events.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({ where, orderBy, take }: { where: any; orderBy?: any; take?: number }) => {
          let rows = state.events.filter((e) => {
            if (where.workspaceId && e.workspaceId !== where.workspaceId) return false;
            if (where.agentId && e.agentId !== where.agentId) return false;
            return inRange(e.occurredAt, where.occurredAt?.gte, where.occurredAt?.lte);
          });
          if (orderBy?.occurredAt === 'desc') {
            rows = [...rows].sort(
              (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
            );
          }
          if (take) rows = rows.slice(0, take);
          return rows;
        },
      ),
    },
    call: {
      findMany: vi.fn(async ({ where }: { where: any }) => {
        return state.calls.filter((c) => {
          if (where.workspaceId && where.workspaceId !== 'ws-1') return false;
          if (where.agentId && c.agentId !== where.agentId) return false;
          return inRange(c.createdAt, where.createdAt?.gte, where.createdAt?.lte);
        });
      }),
    },
    complianceCheck: {
      count: vi.fn(async ({ where }: { where: any }) => {
        return state.compliance.filter(
          (c) =>
            c.status === where.status &&
            (!where.agentId || c.agentId === where.agentId) &&
            inRange(c.checkedAt, where.checkedAt?.gte, where.checkedAt?.lte),
        ).length;
      }),
      findMany: vi.fn(async ({ where }: { where: any }) => {
        return state.compliance.filter(
          (c) =>
            c.status === where.status &&
            (!where.agentId || c.agentId === where.agentId) &&
            inRange(c.checkedAt, where.checkedAt?.gte, where.checkedAt?.lte),
        );
      }),
    },
    contact: {
      count: vi.fn(async ({ where }: { where: any }) => {
        return state.contacts.filter(
          (c) =>
            c.optOut === where.optOut &&
            c.optOutAt !== null &&
            inRange(c.optOutAt!, where.optOutAt?.gte, where.optOutAt?.lte),
        ).length;
      }),
    },
    agent: {
      findMany: vi.fn(async ({ where }: { where: any }) => {
        return state.agents.filter((a) => !where.id || a.id === where.id);
      }),
    },
    toolInvocation: {
      groupBy: vi.fn(async ({ where }: { where: any }) => {
        const subset = state.tools.filter(
          (t) =>
            (!where.agentId || t.agentId === where.agentId) &&
            inRange(t.startedAt, where.startedAt?.gte, where.startedAt?.lte),
        );
        const map = new Map<string, number>();
        for (const t of subset) map.set(t.status, (map.get(t.status) ?? 0) + 1);
        return [...map.entries()].map(([status, count]) => ({
          status,
          _count: { _all: count },
        }));
      }),
    },
    callEvaluation: {
      aggregate: vi.fn(async ({ where }: { where: any }) => {
        const subset = state.evals.filter(
          (e) =>
            (!where.agentId || e.agentId === where.agentId) &&
            inRange(e.createdAt, where.createdAt?.gte, where.createdAt?.lte),
        );
        if (subset.length === 0) {
          return { _avg: { overallScore: null }, _count: { _all: 0 } };
        }
        const avg =
          subset.reduce((s, e) => s + e.overallScore, 0) / subset.length;
        return { _avg: { overallScore: avg }, _count: { _all: subset.length } };
      }),
    },
  };
}

function defaultState() {
  const t = (h: number) => new Date(2026, 3, 20, h);
  return {
    calls: [
      { id: 'c1', status: 'completed', durationSeconds: 120, outcome: 'appointment_booked', agentId: 'a1', direction: 'outbound', createdAt: t(10) },
      { id: 'c2', status: 'completed', durationSeconds: 90, outcome: 'lead_qualified', agentId: 'a1', direction: 'outbound', createdAt: t(11) },
      { id: 'c3', status: 'failed', durationSeconds: 5, outcome: 'caller_hung_up', agentId: 'a1', direction: 'outbound', createdAt: t(12) },
      { id: 'c4', status: 'completed', durationSeconds: 30, outcome: 'message_taken', agentId: 'a2', direction: 'inbound', createdAt: t(13) },
    ] as CallRow[],
    tools: [
      { status: 'success', agentId: 'a1', startedAt: t(10) },
      { status: 'success', agentId: 'a1', startedAt: t(11) },
      { status: 'failed', agentId: 'a1', startedAt: t(12) },
    ] as ToolRow[],
    evals: [
      { agentId: 'a1', overallScore: 0.8, createdAt: t(10) },
      { agentId: 'a1', overallScore: 0.6, createdAt: t(11) },
    ] as EvalRow[],
    compliance: [
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'missing_consent' }], checkedAt: t(9) },
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'dnc_listed' }], checkedAt: t(9) },
    ] as ComplianceRow[],
    contacts: [
      { id: 'k1', optOut: true, optOutAt: t(8) },
    ] as ContactRow[],
    agents: [
      { id: 'a1', name: 'Receptionist' },
      { id: 'a2', name: 'Reminder' },
    ] as AgentRow[],
    events: [] as EventRow[],
  };
}

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

describe('AnalyticsService.workspaceMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aggregates calls + outcomes + blocks', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {});
    expect(m.total_calls).toBe(4);
    expect(m.total_minutes).toBeGreaterThan(0);
    expect(m.success_rate).toBeCloseTo(3 / 4, 5);
    expect(m.failed_call_rate).toBeCloseTo(1 / 4, 5);
    expect(m.blocked_calls).toBe(2);
    expect(m.agents_active).toBe(2);
    expect(m.outcomes.find((o) => o.outcome === 'appointment_booked')?.count).toBe(1);
  });

  it('returns zeros on empty workspace', async () => {
    const state = defaultState();
    state.calls = [];
    state.compliance = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {});
    expect(m.total_calls).toBe(0);
    expect(m.success_rate).toBe(0);
    expect(m.answer_rate).toBe(0);
    expect(m.blocked_calls).toBe(0);
  });

  it('handles null durationSeconds without NaN', async () => {
    const state = defaultState();
    state.calls = [
      { id: 'x1', status: 'completed', durationSeconds: null, outcome: 'message_taken', agentId: 'a1', direction: 'inbound', createdAt: new Date(2026, 3, 20, 10) },
      { id: 'x2', status: 'completed', durationSeconds: null, outcome: 'message_taken', agentId: 'a1', direction: 'inbound', createdAt: new Date(2026, 3, 20, 11) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {});
    expect(m.total_minutes).toBe(0);
    expect(Number.isNaN(m.total_minutes)).toBe(false);
    expect(m.total_calls).toBe(2);
  });

  it('rolls null outcome under "unknown" bucket', async () => {
    const state = defaultState();
    state.calls = [
      { id: 'u1', status: 'completed', durationSeconds: 10, outcome: null, agentId: 'a1', direction: 'inbound', createdAt: new Date(2026, 3, 20, 10) },
      { id: 'u2', status: 'completed', durationSeconds: 10, outcome: null, agentId: 'a1', direction: 'inbound', createdAt: new Date(2026, 3, 20, 11) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {});
    expect(m.outcomes.find((o) => o.outcome === 'unknown')?.count).toBe(2);
    expect(m.success_rate).toBe(0);
  });

  it('sorts outcomes by count desc', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [
      { id: '1', status: 'completed', durationSeconds: 10, outcome: 'voicemail', agentId: 'a1', direction: 'outbound', createdAt: t(10) },
      { id: '2', status: 'completed', durationSeconds: 10, outcome: 'voicemail', agentId: 'a1', direction: 'outbound', createdAt: t(11) },
      { id: '3', status: 'completed', durationSeconds: 10, outcome: 'voicemail', agentId: 'a1', direction: 'outbound', createdAt: t(12) },
      { id: '4', status: 'completed', durationSeconds: 10, outcome: 'no_answer', agentId: 'a1', direction: 'outbound', createdAt: t(13) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {});
    expect(m.outcomes[0].outcome).toBe('voicemail');
    expect(m.outcomes[0].count).toBe(3);
    expect(m.outcomes[1].outcome).toBe('no_answer');
  });

  it('respects explicit from/to range filter', async () => {
    const state = defaultState();
    const inWindow = new Date(2026, 3, 20, 12);
    const outOfWindow = new Date(2026, 0, 1, 12);
    state.calls = [
      { id: 'in', status: 'completed', durationSeconds: 60, outcome: 'message_taken', agentId: 'a1', direction: 'inbound', createdAt: inWindow },
      { id: 'out', status: 'completed', durationSeconds: 60, outcome: 'message_taken', agentId: 'a1', direction: 'inbound', createdAt: outOfWindow },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-30T23:59:59.000Z',
    });
    expect(m.total_calls).toBe(1);
  });

  it('agent_id filter narrows results to that agent', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', { agent_id: 'a2' });
    expect(m.total_calls).toBe(1);
    expect(m.outcomes[0].outcome).toBe('message_taken');
  });

  it('all-failed workspace yields failed_call_rate=1, success_rate=0', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [
      { id: 'f1', status: 'failed', durationSeconds: 0, outcome: 'agent_failed', agentId: 'a1', direction: 'outbound', createdAt: t(10) },
      { id: 'f2', status: 'failed', durationSeconds: 0, outcome: 'tool_failed', agentId: 'a1', direction: 'outbound', createdAt: t(11) },
    ];
    state.compliance = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {});
    expect(m.failed_call_rate).toBe(1);
    expect(m.success_rate).toBe(0);
    expect(m.answer_rate).toBe(0);
  });

  it('rounds total_minutes to 2 decimals', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [
      { id: 'm1', status: 'completed', durationSeconds: 75, outcome: 'message_taken', agentId: 'a1', direction: 'inbound', createdAt: t(10) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.workspaceMetrics('ws-1', {});
    expect(m.total_minutes).toBe(1.25);
  });
});

describe('AnalyticsService.agentMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces per-agent rows sorted by call volume', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.agentMetrics('ws-1', {});
    expect(r.agents).toHaveLength(2);
    expect(r.agents[0].agent_id).toBe('a1');
    expect(r.agents[0].total_calls).toBe(3);
    expect(r.agents[0].booking_rate).toBeCloseTo(1 / 3, 5);
    expect(r.agents[0].tool_success_rate).toBeCloseTo(2 / 3, 5);
    expect(r.agents[0].average_evaluation_score).toBeCloseTo(0.7, 5);
  });

  it('agent with zero calls returns zero rates without NaN', async () => {
    const state = defaultState();
    state.calls = [];
    state.tools = [];
    state.evals = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.agentMetrics('ws-1', {});
    for (const row of r.agents) {
      expect(row.total_calls).toBe(0);
      expect(row.success_rate).toBe(0);
      expect(row.booking_rate).toBe(0);
      expect(row.tool_success_rate).toBe(0);
      expect(row.average_duration_seconds).toBe(0);
      expect(row.average_evaluation_score).toBe(0);
      expect(Number.isNaN(row.success_rate)).toBe(false);
    }
  });

  it('agent_id filter returns single row', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.agentMetrics('ws-1', { agent_id: 'a2' });
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0].agent_id).toBe('a2');
    expect(r.agents[0].total_calls).toBe(1);
  });

  it('average_duration_seconds is rounded to integer', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.agentMetrics('ws-1', { agent_id: 'a1' });
    // a1 durations: 120 + 90 + 5 = 215 / 3 = 71.66… → 72
    expect(r.agents[0].average_duration_seconds).toBe(72);
    expect(Number.isInteger(r.agents[0].average_duration_seconds)).toBe(true);
  });

  it('null durations on agent calls do not break average', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [
      { id: 'd1', status: 'completed', durationSeconds: null, outcome: 'message_taken', agentId: 'a1', direction: 'inbound', createdAt: t(10) },
      { id: 'd2', status: 'completed', durationSeconds: 60, outcome: 'message_taken', agentId: 'a1', direction: 'inbound', createdAt: t(11) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.agentMetrics('ws-1', { agent_id: 'a1' });
    expect(r.agents[0].average_duration_seconds).toBe(30);
  });
});

describe('AnalyticsService.complianceMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts block reasons + opt-outs', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.complianceMetrics('ws-1', {});
    expect(m.blocked_calls).toBe(2);
    expect(m.dnc_hits).toBe(1);
    expect(m.missing_consent).toBe(1);
    expect(m.opt_outs).toBe(1);
    expect(m.block_reasons.map((r) => r.code)).toContain('missing_consent');
  });

  it('counts multiple reasons in a single check', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.compliance = [
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'missing_consent' }, { code: 'dnc_listed' }], checkedAt: t(9) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.complianceMetrics('ws-1', {});
    expect(m.blocked_calls).toBe(1);
    expect(m.missing_consent).toBe(1);
    expect(m.dnc_hits).toBe(1);
    expect(m.block_reasons).toHaveLength(2);
  });

  it('handles empty reasons array and reasons missing code', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.compliance = [
      { agentId: 'a1', status: 'blocked', reasons: [], checkedAt: t(9) },
      { agentId: 'a1', status: 'blocked', reasons: [{}], checkedAt: t(9) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.complianceMetrics('ws-1', {});
    expect(m.blocked_calls).toBe(2);
    expect(m.block_reasons).toHaveLength(0);
    expect(m.missing_consent).toBe(0);
    expect(m.dnc_hits).toBe(0);
  });

  it('sorts block_reasons by count desc', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.compliance = [
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'dnc_listed' }], checkedAt: t(9) },
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'dnc_listed' }], checkedAt: t(9) },
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'dnc_listed' }], checkedAt: t(9) },
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'missing_consent' }], checkedAt: t(9) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.complianceMetrics('ws-1', {});
    expect(m.block_reasons[0].code).toBe('dnc_listed');
    expect(m.block_reasons[0].count).toBe(3);
    expect(m.block_reasons[1].code).toBe('missing_consent');
  });

  it('opt-out outside time window is excluded', async () => {
    const state = defaultState();
    state.contacts = [
      { id: 'k1', optOut: true, optOutAt: new Date(2025, 0, 1, 10) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.complianceMetrics('ws-1', {
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-30T23:59:59.000Z',
    });
    expect(m.opt_outs).toBe(0);
  });

  it('agent_id filter narrows blocked checks', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.compliance = [
      { agentId: 'a1', status: 'blocked', reasons: [{ code: 'missing_consent' }], checkedAt: t(9) },
      { agentId: 'a2', status: 'blocked', reasons: [{ code: 'dnc_listed' }], checkedAt: t(9) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const m = await svc.complianceMetrics('ws-1', { agent_id: 'a2' });
    expect(m.blocked_calls).toBe(1);
    expect(m.dnc_hits).toBe(1);
    expect(m.missing_consent).toBe(0);
  });
});

describe('AnalyticsService.improvementSuggestions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flags compliance blocks and tool failures', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    const codes = r.suggestions.map((s) => s.code);
    expect(codes).toContain('compliance_blocks');
    expect(codes).toContain('tool_failure_rate_high');
  });

  it('skips suggestions when call volume is too low', async () => {
    const state = defaultState();
    state.calls = [];
    state.tools = [];
    state.compliance = [];
    state.evals = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    expect(r.suggestions).toHaveLength(0);
  });

  it('does not flag low_success_rate below 5-call threshold even at 0% success', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [
      { id: 'l1', status: 'failed', durationSeconds: 5, outcome: 'agent_failed', agentId: 'a1', direction: 'outbound', createdAt: t(10) },
      { id: 'l2', status: 'failed', durationSeconds: 5, outcome: 'agent_failed', agentId: 'a1', direction: 'outbound', createdAt: t(11) },
      { id: 'l3', status: 'failed', durationSeconds: 5, outcome: 'agent_failed', agentId: 'a1', direction: 'outbound', createdAt: t(12) },
      { id: 'l4', status: 'failed', durationSeconds: 5, outcome: 'agent_failed', agentId: 'a1', direction: 'outbound', createdAt: t(13) },
    ];
    state.tools = [];
    state.compliance = [];
    state.evals = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    expect(r.suggestions.find((s) => s.code === 'low_success_rate')).toBeUndefined();
  });

  it('flags low_success_rate at exactly 5-call threshold', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      status: 'failed',
      durationSeconds: 30,
      outcome: 'agent_failed',
      agentId: 'a1',
      direction: 'outbound',
      createdAt: t(10 + i),
    }));
    state.tools = [];
    state.compliance = [];
    state.evals = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    const s = r.suggestions.find((x) => x.code === 'low_success_rate');
    expect(s).toBeDefined();
    expect(s?.severity).toBe('warning');
    expect(s?.evidence_count).toBe(5);
  });

  it('flags high_short_call_rate when > 30% calls < 15s', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [
      { id: '1', status: 'completed', durationSeconds: 5, outcome: 'caller_hung_up', agentId: 'a1', direction: 'outbound', createdAt: t(10) },
      { id: '2', status: 'completed', durationSeconds: 5, outcome: 'caller_hung_up', agentId: 'a1', direction: 'outbound', createdAt: t(11) },
      { id: '3', status: 'completed', durationSeconds: 5, outcome: 'caller_hung_up', agentId: 'a1', direction: 'outbound', createdAt: t(12) },
      { id: '4', status: 'completed', durationSeconds: 60, outcome: 'message_taken', agentId: 'a1', direction: 'outbound', createdAt: t(13) },
      { id: '5', status: 'completed', durationSeconds: 60, outcome: 'message_taken', agentId: 'a1', direction: 'outbound', createdAt: t(14) },
    ];
    state.tools = [];
    state.compliance = [];
    state.evals = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    const s = r.suggestions.find((x) => x.code === 'high_short_call_rate');
    expect(s).toBeDefined();
    expect(s?.evidence_count).toBe(3);
  });

  it('escalates compliance_blocks severity to critical at >= 5 blocks', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [];
    state.tools = [];
    state.compliance = Array.from({ length: 5 }, () => ({
      agentId: 'a1',
      status: 'blocked',
      reasons: [{ code: 'dnc_listed' }],
      checkedAt: t(9),
    }));
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    const s = r.suggestions.find((x) => x.code === 'compliance_blocks');
    expect(s?.severity).toBe('critical');
    expect(s?.evidence_count).toBe(5);
  });

  it('keeps compliance_blocks severity warning when < 5', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    const s = r.suggestions.find((x) => x.code === 'compliance_blocks');
    expect(s?.severity).toBe('warning');
  });

  it('flags low_evaluation_score when avg < 0.5 and count >= 3', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.evals = [
      { agentId: 'a1', overallScore: 0.3, createdAt: t(10) },
      { agentId: 'a1', overallScore: 0.4, createdAt: t(11) },
      { agentId: 'a1', overallScore: 0.45, createdAt: t(12) },
    ];
    state.calls = [];
    state.tools = [];
    state.compliance = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    expect(r.suggestions.find((s) => s.code === 'low_evaluation_score')).toBeDefined();
  });

  it('skips low_evaluation_score with only 2 evals (below 3 threshold)', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.evals = [
      { agentId: 'a1', overallScore: 0.1, createdAt: t(10) },
      { agentId: 'a1', overallScore: 0.1, createdAt: t(11) },
    ];
    state.calls = [];
    state.tools = [];
    state.compliance = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    expect(r.suggestions.find((s) => s.code === 'low_evaluation_score')).toBeUndefined();
  });

  it('skips tool_failure_rate_high when toolTotal < 3', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = [];
    state.tools = [
      { status: 'failed', agentId: 'a1', startedAt: t(10) },
      { status: 'failed', agentId: 'a1', startedAt: t(11) },
    ];
    state.compliance = [];
    state.evals = [];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    expect(r.suggestions.find((s) => s.code === 'tool_failure_rate_high')).toBeUndefined();
  });

  it('emits multiple suggestions when several conditions trigger', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    // 6 short failed calls → low_success + high_short_call
    state.calls = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      status: 'failed',
      durationSeconds: 5,
      outcome: 'agent_failed',
      agentId: 'a1',
      direction: 'outbound',
      createdAt: t(10 + i),
    }));
    // 5 of 5 tools failed → tool_failure_rate_high (critical)
    state.tools = Array.from({ length: 5 }, () => ({ status: 'failed', agentId: 'a1', startedAt: t(10) }));
    // 6 blocks → compliance_blocks (critical)
    state.compliance = Array.from({ length: 6 }, () => ({ agentId: 'a1', status: 'blocked', reasons: [{ code: 'dnc_listed' }], checkedAt: t(9) }));
    // 4 low evals → low_evaluation_score
    state.evals = Array.from({ length: 4 }, () => ({ agentId: 'a1', overallScore: 0.2, createdAt: t(10) }));
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    const codes = r.suggestions.map((s) => s.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'low_success_rate',
        'high_short_call_rate',
        'tool_failure_rate_high',
        'compliance_blocks',
        'low_evaluation_score',
      ]),
    );
    expect(r.suggestions.find((s) => s.code === 'compliance_blocks')?.severity).toBe(
      'critical',
    );
    expect(r.suggestions.find((s) => s.code === 'tool_failure_rate_high')?.severity).toBe(
      'critical',
    );
  });

  it('healthy agent emits no suggestions', async () => {
    const state = defaultState();
    const t = (h: number) => new Date(2026, 3, 20, h);
    state.calls = Array.from({ length: 10 }, (_, i) => ({
      id: `h${i}`,
      status: 'completed',
      durationSeconds: 120,
      outcome: 'appointment_booked',
      agentId: 'a1',
      direction: 'outbound',
      createdAt: t(10 + (i % 12)),
    }));
    state.tools = Array.from({ length: 10 }, () => ({ status: 'success', agentId: 'a1', startedAt: t(10) }));
    state.compliance = [];
    state.evals = Array.from({ length: 5 }, () => ({ agentId: 'a1', overallScore: 0.9, createdAt: t(10) }));
    const svc = new AnalyticsService(makePrisma(state) as never);
    const r = await svc.improvementSuggestions('ws-1', 'a1', {});
    expect(r.suggestions).toHaveLength(0);
  });
});

describe('AnalyticsService.recordEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a row and returns the DTO', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const e = await svc.recordEvent('ws-1', {
      event_type: 'appointment.booked',
      agent_id: UUID_A,
    });
    expect(e.event_type).toBe('appointment.booked');
    expect(e.workspace_id).toBe('ws-1');
    expect(state.events).toHaveLength(1);
  });

  it('persists payload + occurred_at when provided', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const occurred = '2026-04-25T12:00:00.000Z';
    const e = await svc.recordEvent('ws-1', {
      event_type: 'lead.qualified',
      agent_id: UUID_A,
      payload: { score: 0.9, source: 'inbound' },
      occurred_at: occurred,
    });
    expect(e.occurred_at).toBe(occurred);
    expect(state.events[0].payload).toEqual({ score: 0.9, source: 'inbound' });
  });

  it('defaults agent_id and call_id to null when omitted', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    const e = await svc.recordEvent('ws-1', { event_type: 'workspace.touched' });
    expect(e.agent_id).toBeNull();
    expect(e.call_id).toBeNull();
  });
});

describe('AnalyticsService.recordEventInternal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes when prisma succeeds', async () => {
    const state = defaultState();
    const svc = new AnalyticsService(makePrisma(state) as never);
    await svc.recordEventInternal({
      workspaceId: 'ws-1',
      agentId: UUID_A,
      callId: UUID_B,
      eventType: 'call.started',
      payload: { direction: 'outbound' },
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0].eventType).toBe('call.started');
  });

  it('swallows prisma errors (best-effort)', async () => {
    const state = defaultState();
    const prisma = makePrisma(state);
    prisma.analyticsEvent.create = vi.fn(async () => {
      throw new Error('db down');
    });
    const svc = new AnalyticsService(prisma as never);
    await expect(
      svc.recordEventInternal({
        workspaceId: 'ws-1',
        eventType: 'call.started',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AnalyticsService.listEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns events ordered by occurredAt desc with default 30-day window', async () => {
    const state = defaultState();
    const now = new Date();
    state.events = [
      { id: 'e1', workspaceId: 'ws-1', agentId: null, callId: null, eventType: 'call.started', payload: null, occurredAt: new Date(now.getTime() - 3 * 86400_000) },
      { id: 'e2', workspaceId: 'ws-1', agentId: null, callId: null, eventType: 'call.ended', payload: null, occurredAt: new Date(now.getTime() - 1 * 86400_000) },
      { id: 'e3', workspaceId: 'ws-1', agentId: null, callId: null, eventType: 'old', payload: null, occurredAt: new Date(now.getTime() - 90 * 86400_000) },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const rows = await svc.listEvents('ws-1', {});
    expect(rows).toHaveLength(2);
    expect(rows[0].event_type).toBe('call.ended');
    expect(rows[1].event_type).toBe('call.started');
  });

  it('filters by agent_id when provided', async () => {
    const state = defaultState();
    const now = new Date();
    state.events = [
      { id: 'e1', workspaceId: 'ws-1', agentId: UUID_A, callId: null, eventType: 'a', payload: null, occurredAt: now },
      { id: 'e2', workspaceId: 'ws-1', agentId: UUID_B, callId: null, eventType: 'b', payload: null, occurredAt: now },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const rows = await svc.listEvents('ws-1', { agent_id: UUID_A });
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe(UUID_A);
  });

  it('excludes other workspaces', async () => {
    const state = defaultState();
    const now = new Date();
    state.events = [
      { id: 'e1', workspaceId: 'ws-1', agentId: null, callId: null, eventType: 'mine', payload: null, occurredAt: now },
      { id: 'e2', workspaceId: 'ws-2', agentId: null, callId: null, eventType: 'theirs', payload: null, occurredAt: now },
    ];
    const svc = new AnalyticsService(makePrisma(state) as never);
    const rows = await svc.listEvents('ws-1', {});
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('mine');
  });
});
