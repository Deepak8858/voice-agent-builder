import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import type { AgentSpec } from '@voiceforge/shared';
import { AgentSpecSchema } from '@voiceforge/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schema_version: '1.0',
    name: 'Dental Receptionist',
    industry: 'dental',
    agent_type: 'inbound_receptionist',
    language: 'en',
    voice: { tone: 'warm', allow_interruptions: true },
    identity: { business_name: 'Acme Dental', agent_name: 'Ava' },
    goals: ['book appointments'],
    required_fields: [],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
    tools: [],
    handoff: { enabled: true, conditions: ['caller_requests_human'] },
    compliance: {
      ai_disclosure_required: true,
      recording_notice_required: false,
      opt_out_enabled: true,
      consent_required_for_outbound: true,
    },
    analytics: { success_events: [] },
    ...overrides,
  };
}

function makeAgentsService(prisma: Record<string, unknown>) {
  return new AgentsService(
    prisma as never,
    { log: vi.fn(async () => {}) } as never,
    { generate: vi.fn() } as never,
    { resolveReferencedSourceIds: vi.fn(async () => []) } as never,
    {
      name: 'mock',
      createAgent: vi.fn(async () => ({ provider_runtime_id: 'mock' })),
      updateAgent: vi.fn(async () => {}),
    } as never,
    { get: vi.fn(async () => null), set: vi.fn(async () => {}) } as never,
    { invalidateAgentList: vi.fn(async () => {}) } as never,
    { enforceAgentLimit: vi.fn(async () => {}) } as never,
  );
}

function getUpdateFlowValidationPipe(): ZodValidationPipe<ZodTypeAny> {
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    AgentsController,
    'updateFlow',
  ) as Record<string, { pipes?: unknown[] }>;

  const pipe = Object.values(metadata)
    .flatMap((entry) => entry.pipes ?? [])
    .find((candidate) => candidate instanceof ZodValidationPipe);

  if (!(pipe instanceof ZodValidationPipe)) {
    throw new Error('updateFlow route does not expose a ZodValidationPipe');
  }

  return pipe;
}

describe('AgentsController.updateFlow', () => {
  it('registers the save endpoint as PUT /:agentId/flow', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentsController.prototype.updateFlow)).toBe(
      ':agentId/flow',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, AgentsController.prototype.updateFlow)).toBe(
      RequestMethod.PUT,
    );
  });

  it('accepts React Flow payloads using canonical Agent Spec node types', () => {
    const pipe = getUpdateFlowValidationPipe();

    expect(() =>
      pipe.transform(
        {
          nodes: [
            { id: 'start', type: 'start', data: {} },
            { id: 'ask', type: 'ask_question', data: { question: 'How can I help?' } },
            { id: 'tool', type: 'tool_call', data: { tool_name: 'calendar.book' } },
            { id: 'end', type: 'end', data: {} },
          ],
          edges: [
            { id: 'e-start-ask', source: 'start', target: 'ask' },
            { id: 'e-ask-tool', source: 'ask', target: 'tool' },
            { id: 'e-tool-end', source: 'tool', target: 'end' },
          ],
        },
        { type: 'body' } as never,
      ),
    ).not.toThrow();
  });
});

describe('AgentsService.get', () => {
  it('returns the agent draft spec when it exists so the builder reads saved flow edits', async () => {
    const draftSpec = spec({ name: 'Draft spec' });
    const deployedSpec = spec({ name: 'Deployed spec' });
    const prisma = {
      agent: {
        findFirst: vi.fn(async () => ({
          id: 'a1',
          workspaceId: 'w1',
          name: 'Agent',
          description: null,
          industry: 'dental',
          agentType: 'inbound_receptionist',
          status: 'draft',
          specJson: draftSpec,
          activeVersionId: 'v1',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
          versions: [
            {
              id: 'v1',
              agentId: 'a1',
              versionNumber: 1,
              specJson: deployedSpec,
              deploymentStatus: 'deployed',
              provider: 'mock',
              providerRuntimeId: 'runtime-1',
              createdAt: new Date('2026-01-01T00:00:00Z'),
              note: null,
            },
          ],
        })),
      },
    };
    const service = makeAgentsService(prisma);

    const result = await service.get('w1', 'a1');

    expect(result.active_spec?.name).toBe('Draft spec');
  });
});

describe('AgentsService.updateFlow', () => {
  it('stores a valid Agent Spec flow with sequential and conditional edges', async () => {
    const baseSpec = spec();
    const update = vi.fn(async ({ data }: { data: { specJson: unknown } }) => ({
      id: 'a1',
      specJson: data.specJson,
    }));
    const prisma = {
      agent: {
        findFirstOrThrow: vi.fn(async () => ({
          id: 'a1',
          workspaceId: 'w1',
          specJson: baseSpec,
          activeVersionId: null,
          versions: [],
        })),
        update,
      },
      integrationTool: {
        findMany: vi.fn(async () => []),
      },
    };
    const service = makeAgentsService(prisma);
    service.get = vi.fn(async () => ({ id: 'a1' })) as never;

    await service.updateFlow('w1', 'a1', 'u1', {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'ask', type: 'ask_question', data: { question: 'How can I help?', capture_field: 'intent' } },
        { id: 'branch', type: 'condition', data: { expression: "intent === 'urgent'" } },
        { id: 'transfer', type: 'transfer', data: { target_phone: '+14155550123' } },
        { id: 'end', type: 'end', data: {} },
      ],
      edges: [
        { id: 'e-start-ask', source: 'start', target: 'ask' },
        { id: 'e-ask-branch', source: 'ask', target: 'branch' },
        { id: 'e-branch-true-transfer', source: 'branch', target: 'transfer', sourceHandle: 'true' },
        { id: 'e-branch-false-end', source: 'branch', target: 'end', sourceHandle: 'false' },
      ],
    });

    const savedSpec = update.mock.calls[0]?.[0].data.specJson as AgentSpec;
    const parsed = AgentSpecSchema.safeParse(savedSpec);
    expect(parsed.success).toBe(true);
    expect(savedSpec.flow).toEqual({
      start_node_id: 'start',
      nodes: [
        { id: 'start', type: 'start', next: 'ask' },
        {
          id: 'ask',
          type: 'ask_question',
          question: 'How can I help?',
          capture_field: 'intent',
          next: 'branch',
        },
        {
          id: 'branch',
          type: 'condition',
          expression: "intent === 'urgent'",
          on_true: 'transfer',
          on_false: 'end',
        },
        { id: 'transfer', type: 'transfer', target_phone: '+14155550123' },
        { id: 'end', type: 'end' },
      ],
    });
  });

  it('adds referenced workspace integration tools to Agent Spec tools when saving flow', async () => {
    const baseSpec = spec();
    const update = vi.fn(async ({ data }: { data: { specJson: unknown } }) => ({
      id: 'a1',
      specJson: data.specJson,
    }));
    const prisma = {
      agent: {
        findFirstOrThrow: vi.fn(async () => ({
          id: 'a1',
          workspaceId: 'w1',
          specJson: baseSpec,
          activeVersionId: null,
          versions: [],
        })),
        update,
      },
      integrationTool: {
        findMany: vi.fn(async () => [
          {
            name: 'google_calendar_booking',
            description: 'Books appointments on Google Calendar.',
            inputSchema: {
              type: 'object',
              properties: {
                operation: { type: 'string' },
                start_iso: { type: 'string' },
              },
              required: ['operation'],
            },
            toolType: 'google_calendar',
          },
        ]),
      },
    };
    const service = makeAgentsService(prisma);
    service.get = vi.fn(async () => ({ id: 'a1' })) as never;

    await service.updateFlow('w1', 'a1', 'u1', {
      nodes: [
        { id: 'start', type: 'start', data: {} },
        { id: 'tool', type: 'tool_call', data: { tool_name: 'google_calendar_booking' } },
        { id: 'end', type: 'end', data: {} },
      ],
      edges: [
        { id: 'e-start-tool', source: 'start', target: 'tool' },
        { id: 'e-tool-end', source: 'tool', target: 'end' },
      ],
    });

    const savedSpec = update.mock.calls[0]?.[0].data.specJson as AgentSpec;
    expect(prisma.integrationTool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'w1',
          enabled: true,
          name: {
            in: expect.arrayContaining([
              'google_calendar_booking',
              'book_calendar_event',
              'send_gmail',
              'append_sheet_row',
            ]),
          },
        }),
      }),
    );
    expect(savedSpec.tools).toEqual([
      {
        name: 'google_calendar_booking',
        description: 'Books appointments on Google Calendar.',
        requires_confirmation: true,
        input_schema: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            start_iso: { type: 'string' },
          },
          required: ['operation'],
        },
        permissions: ['google_calendar'],
      },
    ]);
  });
});
