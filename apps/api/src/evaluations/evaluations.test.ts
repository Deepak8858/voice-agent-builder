import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import { EvaluationsService } from './evaluations.service';

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schema_version: '1.0',
    name: 'Test Agent',
    industry: 'dental',
    agent_type: 'inbound_receptionist',
    language: 'en',
    voice: { tone: 'warm', allow_interruptions: true },
    identity: { business_name: 'Acme', agent_name: 'Ava' },
    goals: ['book appointments', 'collect contact info'],
    required_fields: [
      { key: 'name', type: 'string', required: true },
      { key: 'phone', type: 'phone', required: true },
    ],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge: {
      retrieval_mode: 'agent_scoped',
      max_chunks: 5,
      source_ids: [],
    },
    tools: [],
    handoff: { enabled: true, conditions: ['emergency'] },
    compliance: {
      ai_disclosure_required: true,
      recording_notice_required: false,
      opt_out_enabled: true,
      consent_required_for_outbound: true,
    },
    analytics: { success_events: ['agent.booking_created'] },
    ...overrides,
  } as AgentSpec;
}

interface MockCallRow {
  id: string;
  workspaceId: string;
  agentId: string;
  agentVersionId: string | null;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  transcriptText: string | null;
  outcome: string | null;
  events: Array<{ eventType: string }>;
}

function makePrismaMock(call: MockCallRow | null, version: { specJson: AgentSpec } | null) {
  const evaluationStore = new Map<string, unknown>();
  return {
    call: {
      findUnique: vi.fn(async () => call),
    },
    agentVersion: {
      findUnique: vi.fn(async () => version),
    },
    callEvaluation: {
      findFirst: vi.fn(async ({ where }: { where: { callId: string } }) =>
        evaluationStore.get(where.callId) ?? null,
      ),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        const row = {
          id: 'eval-1',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          ...create,
        };
        evaluationStore.set(create.callId as string, row);
        return row;
      }),
    },
  };
}

describe('EvaluationsService', () => {
  let service: EvaluationsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock(null, null);
    service = new EvaluationsService(prisma as never);
  });

  it('returns null when call is missing', async () => {
    expect(await service.evaluateCall('missing')).toBeNull();
  });

  it('returns null when call is not completed', async () => {
    prisma = makePrismaMock(
      {
        id: 'c1',
        workspaceId: 'w',
        agentId: 'a',
        agentVersionId: 'v',
        status: 'in_progress',
        startedAt: new Date(),
        endedAt: null,
        durationSeconds: null,
        transcriptText: null,
        outcome: null,
        events: [],
      },
      { specJson: spec() },
    );
    service = new EvaluationsService(prisma as never);
    expect(await service.evaluateCall('c1')).toBeNull();
  });

  it('scores a perfect call with all goals/fields/events present', async () => {
    prisma = makePrismaMock(
      {
        id: 'c1',
        workspaceId: 'w',
        agentId: 'a',
        agentVersionId: 'v',
        status: 'completed',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-01-01T00:02:00Z'),
        durationSeconds: 120,
        transcriptText:
          'agent: book appointments today. caller: name is John, phone is 5551234567. agent: collect contact info confirmed.',
        outcome: 'booked',
        events: [{ eventType: 'agent.booking_created' }],
      },
      { specJson: spec() },
    );
    service = new EvaluationsService(prisma as never);
    const result = await service.evaluateCall('c1');
    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(1);
    const map = Object.fromEntries(result!.metric_scores.map((m) => [m.name, m.score]));
    expect(map.goal_coverage).toBe(1);
    expect(map.required_fields_captured).toBe(1);
    expect(map.success_events).toBe(1);
    expect(map.duration_health).toBe(1);
  });

  it('scores zero when transcript is empty and no events fired', async () => {
    prisma = makePrismaMock(
      {
        id: 'c2',
        workspaceId: 'w',
        agentId: 'a',
        agentVersionId: 'v',
        status: 'completed',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-01-01T00:00:02Z'),
        durationSeconds: 2,
        transcriptText: '',
        outcome: 'no_answer',
        events: [],
      },
      { specJson: spec() },
    );
    service = new EvaluationsService(prisma as never);
    const result = await service.evaluateCall('c2');
    expect(result).not.toBeNull();
    const map = Object.fromEntries(result!.metric_scores.map((m) => [m.name, m.score]));
    expect(map.goal_coverage).toBe(0);
    expect(map.required_fields_captured).toBe(0);
    expect(map.success_events).toBe(0);
    expect(map.duration_health).toBe(0.2);
    expect(result!.overall_score).toBeCloseTo(0.05, 2);
  });

  it('handles missing version spec gracefully (only duration_health metric)', async () => {
    prisma = makePrismaMock(
      {
        id: 'c3',
        workspaceId: 'w',
        agentId: 'a',
        agentVersionId: null,
        status: 'completed',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-01-01T00:00:45Z'),
        durationSeconds: 45,
        transcriptText: 'hello',
        outcome: null,
        events: [],
      },
      null,
    );
    service = new EvaluationsService(prisma as never);
    const result = await service.evaluateCall('c3');
    expect(result).not.toBeNull();
    expect(result!.metric_scores.map((m) => m.name)).toEqual(['duration_health']);
    expect(result!.overall_score).toBe(1);
  });

  it('treats spec with empty success_events array as not contributing', async () => {
    prisma = makePrismaMock(
      {
        id: 'c4',
        workspaceId: 'w',
        agentId: 'a',
        agentVersionId: 'v',
        status: 'completed',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-01-01T00:01:00Z'),
        durationSeconds: 60,
        transcriptText: 'book appointments. name. phone. collect contact info.',
        outcome: null,
        events: [],
      },
      { specJson: spec({ analytics: { success_events: [] } }) },
    );
    service = new EvaluationsService(prisma as never);
    const result = await service.evaluateCall('c4');
    expect(result).not.toBeNull();
    expect(result!.metric_scores.find((m) => m.name === 'success_events')).toBeUndefined();
    const map = Object.fromEntries(result!.metric_scores.map((m) => [m.name, m.score]));
    expect(map.goal_coverage).toBe(1);
    expect(map.required_fields_captured).toBe(1);
    expect(map.duration_health).toBe(1);
  });

  it('clamps overlong calls to 0.7 duration health', async () => {
    prisma = makePrismaMock(
      {
        id: 'c5',
        workspaceId: 'w',
        agentId: 'a',
        agentVersionId: null,
        status: 'completed',
        startedAt: new Date(),
        endedAt: new Date(),
        durationSeconds: 1200,
        transcriptText: '',
        outcome: null,
        events: [],
      },
      null,
    );
    service = new EvaluationsService(prisma as never);
    const result = await service.evaluateCall('c5');
    expect(result!.metric_scores[0].score).toBe(0.7);
  });

  it('summary string identifies weakest metric', async () => {
    prisma = makePrismaMock(
      {
        id: 'c6',
        workspaceId: 'w',
        agentId: 'a',
        agentVersionId: 'v',
        status: 'completed',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-01-01T00:01:00Z'),
        durationSeconds: 60,
        transcriptText: 'book appointments. collect contact info.',
        outcome: 'partial',
        events: [{ eventType: 'agent.booking_created' }],
      },
      { specJson: spec() },
    );
    service = new EvaluationsService(prisma as never);
    const result = await service.evaluateCall('c6');
    expect(result!.summary).toMatch(/weakest=required_fields_captured/);
  });
});
