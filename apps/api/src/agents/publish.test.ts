import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import { AgentsService } from './agents.service';
import { AgentSpecInvalidError, AgentNotFoundError } from '../common/errors';

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schema_version: '1.0',
    name: 'Test',
    industry: 'dental',
    agent_type: 'inbound_receptionist',
    language: 'en',
    voice: { tone: 'warm', allow_interruptions: true },
    identity: { business_name: 'Acme', agent_name: 'Ava' },
    goals: ['book'],
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
  organizationId?: string | null;
  status: string;
  specJson?: unknown;
  activeVersionId: string | null;
  versions: Array<{
    id: string;
    agentId: string;
    versionNumber: number;
    specJson: unknown;
    deploymentStatus: string;
    provider: string | null;
    providerRuntimeId: string | null;
    createdAt: Date;
    note: string | null;
  }>;
}

function makeAgentsServiceWith(opts: {
  initialAgent: AgentRow | null;
  voiceCreate?: () => Promise<{ provider_runtime_id: string }>;
  voiceUpdate?: () => Promise<void>;
  voiceName?: string;
  subscriptionPlan?: 'free' | 'starter' | 'growth' | 'enterprise';
  voiceRegistry?: {
    forPlan: ReturnType<typeof vi.fn>;
  };
}) {
  const agentUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (opts.initialAgent) Object.assign(opts.initialAgent, data);
    return opts.initialAgent;
  });
  const versionUpdate = vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
    const v = opts.initialAgent?.versions.find((x) => x.id === where.id);
    if (v) Object.assign(v, data);
    return v;
  });
  const versionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const created = {
      id: 'v-created',
      agentId: data.agentId as string,
      versionNumber: data.versionNumber as number,
      specJson: data.specJson,
      deploymentStatus: 'not_deployed',
      provider: null,
      providerRuntimeId: null,
      createdAt: new Date(),
      note: (data.note as string | undefined) ?? null,
    };
    opts.initialAgent?.versions.unshift(created);
    return created;
  });
  const prisma = {
    agent: {
      findFirst: vi.fn(async () => opts.initialAgent),
      update: agentUpdate,
      count: vi.fn(async () => 1),
    },
    agentVersion: {
      findFirst: vi.fn(async () => opts.initialAgent?.versions[0] ?? null),
      create: versionCreate,
      update: versionUpdate,
    },
    integrationTool: {
      findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'w1', organizationId: 'org1' })),
    },
    organizationIdFor: vi.fn(async () => 'org1'),
  };
  const audit = { log: vi.fn(async () => {}) };
  const generator = { generate: vi.fn() };
  const knowledge = { resolveReferencedSourceIds: vi.fn(async () => []) };
  const voice = {
    name: opts.voiceName ?? 'mock',
    createAgent:
      opts.voiceCreate ?? vi.fn(async () => ({ provider_runtime_id: 'mock_rt_1' })),
    updateAgent: opts.voiceUpdate ?? vi.fn(async () => {}),
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => {}), del: vi.fn(async () => {}) };
  const cacheInvalidator = { invalidateAgentList: vi.fn(async () => {}) };
  const billing = {
    enforceAgentLimit: vi.fn(async () => {}),
    getSubscription: vi.fn(async () => ({
      id: 'sub-1',
      plan: opts.subscriptionPlan ?? 'free',
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      dodoCustomerId: null,
    })),
  };
  const service = new AgentsService(
    prisma as never,
    audit as never,
    generator as never,
    knowledge as never,
    voice as never,
    cache as never,
    cacheInvalidator as never,
    billing as never,
    opts.voiceRegistry as never,
  );
  // Override `get` so we don't need the secondary findFirst with versions loader.
  service.get = vi.fn(async () => ({
    id: opts.initialAgent?.id ?? 'a',
  })) as never;
  return { service, prisma, voice, agentUpdate, versionCreate, versionUpdate, audit, cacheInvalidator, billing };
}

describe('AgentsService.publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws AgentNotFoundError when agent does not exist', async () => {
    const { service } = makeAgentsServiceWith({ initialAgent: null });
    await expect(service.publish('w1', 'missing', 'u1')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it('throws AgentSpecInvalidError when no versions exist', async () => {
    const { service } = makeAgentsServiceWith({
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        status: 'draft',
        activeVersionId: null,
        versions: [],
      },
    });
    await expect(service.publish('w1', 'a1', 'u1')).rejects.toBeInstanceOf(AgentSpecInvalidError);
  });

  it('throws AgentSpecInvalidError when latest spec is invalid', async () => {
    const { service } = makeAgentsServiceWith({
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        status: 'draft',
        activeVersionId: null,
        versions: [
          {
            id: 'v1',
            agentId: 'a1',
            versionNumber: 1,
            specJson: { schema_version: '1.0' }, // missing required fields
            deploymentStatus: 'not_deployed',
            provider: null,
            providerRuntimeId: null,
            createdAt: new Date(),
            note: null,
          },
        ],
      },
    });
    await expect(service.publish('w1', 'a1', 'u1')).rejects.toBeInstanceOf(AgentSpecInvalidError);
  });

  it('first publish: calls voice.createAgent and persists provider_runtime_id', async () => {
    const { service, voice, agentUpdate, versionUpdate } = makeAgentsServiceWith({
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        status: 'draft',
        activeVersionId: null,
        versions: [
          {
            id: 'v1',
            agentId: 'a1',
            versionNumber: 1,
            specJson: spec() as unknown,
            deploymentStatus: 'not_deployed',
            provider: null,
            providerRuntimeId: null,
            createdAt: new Date(),
            note: null,
          },
        ],
      },
      voiceCreate: vi.fn(async () => ({ provider_runtime_id: 'mock_rt_42' })),
    });
    await service.publish('w1', 'a1', 'u1');
    expect(voice.createAgent).toHaveBeenCalledTimes(1);
    expect(voice.updateAgent).not.toHaveBeenCalled();
    expect(agentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'published', activeVersionId: 'v1' }),
      }),
    );
    expect(versionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deploymentStatus: 'deployed',
          provider: 'mock',
          providerRuntimeId: 'mock_rt_42',
        }),
      }),
    );
  });

  it('re-publish: calls voice.updateAgent when provider_runtime_id already set', async () => {
    const { service, voice, billing } = makeAgentsServiceWith({
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        status: 'published',
        activeVersionId: 'v2',
        versions: [
          {
            id: 'v2',
            agentId: 'a1',
            versionNumber: 2,
            specJson: spec() as unknown,
            deploymentStatus: 'deployed',
            provider: 'mock',
            providerRuntimeId: 'mock_rt_existing',
            createdAt: new Date(),
            note: null,
          },
        ],
      },
    });
    await service.publish('w1', 'a1', 'u1');
    expect(voice.updateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider_runtime_id: 'mock_rt_existing' }),
    );
    expect(voice.createAgent).not.toHaveBeenCalled();
    expect(billing.enforceAgentLimit).not.toHaveBeenCalled();
  });

  it('re-publish: does not block an already-published agent when the plan is at its agent limit', async () => {
    const { service, billing, voice } = makeAgentsServiceWith({
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        status: 'published',
        activeVersionId: 'v2',
        versions: [
          {
            id: 'v2',
            agentId: 'a1',
            versionNumber: 2,
            specJson: spec() as unknown,
            deploymentStatus: 'deployed',
            provider: 'mock',
            providerRuntimeId: 'mock_rt_existing',
            createdAt: new Date(),
            note: null,
          },
        ],
      },
    });
    billing.enforceAgentLimit.mockRejectedValue(new Error('plan limit'));

    await expect(service.publish('w1', 'a1', 'u1')).resolves.toBeDefined();

    expect(billing.enforceAgentLimit).not.toHaveBeenCalled();
    expect(voice.updateAgent).toHaveBeenCalledTimes(1);
  });

  it('free plan publishes with the provider chosen by the registry', async () => {
    const standard = {
      name: 'openai-realtime',
      createAgent: vi.fn(async () => ({ provider_runtime_id: 'openai_rt_free' })),
      updateAgent: vi.fn(async () => {}),
    };
    const voiceRegistry = {
      forPlan: vi.fn(() => standard),
    };
    const { service, versionUpdate } = makeAgentsServiceWith({
      subscriptionPlan: 'free',
      voiceRegistry,
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        status: 'draft',
        activeVersionId: null,
        versions: [
          {
            id: 'v1',
            agentId: 'a1',
            versionNumber: 1,
            specJson: spec() as unknown,
            deploymentStatus: 'not_deployed',
            provider: null,
            providerRuntimeId: null,
            createdAt: new Date(),
            note: null,
          },
        ],
      },
    });

    await service.publish('w1', 'a1', 'u1');

    expect(voiceRegistry.forPlan).toHaveBeenCalledWith('free');
    expect(standard.createAgent).toHaveBeenCalledTimes(1);
    expect(versionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'openai-realtime',
          providerRuntimeId: 'openai_rt_free',
        }),
      }),
    );
  });

  it('paid plan publishes with the premium Realtime provider from the registry', async () => {
    const realtime = {
      name: 'openai-realtime',
      createAgent: vi.fn(async () => ({ provider_runtime_id: 'openai_rt_1' })),
      updateAgent: vi.fn(async () => {}),
    };
    const voiceRegistry = {
      forPlan: vi.fn(() => realtime),
    };
    const { service, versionUpdate } = makeAgentsServiceWith({
      subscriptionPlan: 'growth',
      voiceRegistry,
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        status: 'draft',
        activeVersionId: null,
        versions: [
          {
            id: 'v1',
            agentId: 'a1',
            versionNumber: 1,
            specJson: spec() as unknown,
            deploymentStatus: 'not_deployed',
            provider: null,
            providerRuntimeId: null,
            createdAt: new Date(),
            note: null,
          },
        ],
      },
    });

    await service.publish('w1', 'a1', 'u1');

    expect(voiceRegistry.forPlan).toHaveBeenCalledWith('growth');
    expect(realtime.createAgent).toHaveBeenCalledTimes(1);
    expect(versionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'openai-realtime',
          providerRuntimeId: 'openai_rt_1',
        }),
      }),
    );
  });

  it('publishes draft flow edits by snapshotting agent.specJson into a new version', async () => {
    const publishedSpec = spec();
    const draftSpec = spec({
      flow: {
        start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'start', next: 'end' },
          { id: 'end', type: 'end' },
        ],
      },
    });
    const { service, voice, agentUpdate, versionCreate, versionUpdate } = makeAgentsServiceWith({
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        organizationId: 'org1',
        status: 'draft',
        specJson: draftSpec,
        activeVersionId: 'v1',
        versions: [
          {
            id: 'v1',
            agentId: 'a1',
            versionNumber: 1,
            specJson: publishedSpec as unknown,
            deploymentStatus: 'deployed',
            provider: 'mock',
            providerRuntimeId: 'mock_rt_existing',
            createdAt: new Date(),
            note: null,
          },
        ],
      },
      voiceCreate: vi.fn(async () => ({ provider_runtime_id: 'mock_rt_draft' })),
    });

    await service.publish('w1', 'a1', 'u1');

    expect(versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: 'a1',
          organizationId: 'org1',
          versionNumber: 2,
          specJson: draftSpec,
        }),
      }),
    );
    expect(voice.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentVersionId: 'v-created',
        spec: draftSpec,
      }),
    );
    expect(versionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v-created' },
        data: expect.objectContaining({
          deploymentStatus: 'deployed',
          providerRuntimeId: 'mock_rt_draft',
        }),
      }),
    );
    expect(agentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'published', activeVersionId: 'v-created' }),
      }),
    );
  });

  it('adds enabled workspace Google tools to a persisted published version without flow nodes', async () => {
    const initialSpec = spec();
    const { service, prisma, voice, agentUpdate, versionCreate } = makeAgentsServiceWith({
      initialAgent: {
        id: 'a1',
        workspaceId: 'w1',
        organizationId: 'org1',
        status: 'published',
        specJson: initialSpec,
        activeVersionId: 'v1',
        versions: [
          {
            id: 'v1',
            agentId: 'a1',
            versionNumber: 1,
            specJson: initialSpec,
            deploymentStatus: 'deployed',
            provider: 'mock',
            providerRuntimeId: 'mock_rt_existing',
            createdAt: new Date(),
            note: null,
          },
        ],
      },
    });
    prisma.integrationTool.findMany.mockResolvedValueOnce([
      {
        id: 'google-tool-1',
        workspaceId: 'w1',
        organizationId: 'org1',
        agentId: null,
        name: 'append_sheet_row',
        description: 'Append a row to Google Sheets.',
        toolType: 'google_sheets',
        config: { operation: 'append_row', sheet_name: 'Sheet1' },
        inputSchema: {
          type: 'object',
          properties: { values: { type: 'array', items: { type: 'string' } } },
          required: ['values'],
        },
        enabled: true,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await service.publish('w1', 'a1', 'u1');

    const expectedTool = expect.objectContaining({
      name: 'append_sheet_row',
      permissions: ['google_sheets'],
    });
    expect(versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          specJson: expect.objectContaining({ tools: [expectedTool] }),
        }),
      }),
    );
    expect(voice.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentVersionId: 'v-created',
        spec: expect.objectContaining({ tools: [expectedTool] }),
      }),
    );
    expect(agentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activeVersionId: 'v-created',
          specJson: expect.objectContaining({ tools: [expectedTool] }),
        }),
      }),
    );
  });

  it('voice provider failure: marks version failed, throws, leaves agent status unchanged', async () => {
    const initial = {
      id: 'a1',
      workspaceId: 'w1',
      status: 'draft',
      activeVersionId: null,
      versions: [
        {
          id: 'v1',
          agentId: 'a1',
          versionNumber: 1,
          specJson: spec() as unknown,
          deploymentStatus: 'not_deployed',
          provider: null,
          providerRuntimeId: null,
          createdAt: new Date(),
          note: null,
        },
      ],
    };
    const { service, voice, agentUpdate, versionUpdate } = makeAgentsServiceWith({
      initialAgent: initial,
      voiceCreate: vi.fn(async () => {
        throw new Error('provider boom');
      }),
    });
    await expect(service.publish('w1', 'a1', 'u1')).rejects.toBeInstanceOf(AgentSpecInvalidError);
    expect(voice.createAgent).toHaveBeenCalled();
    // Version should be flipped to failed.
    expect(versionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deploymentStatus: 'failed' }),
      }),
    );
    // Agent.update was still called but with status preserved as 'draft'.
    expect(agentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'draft' }),
      }),
    );
  });
});

describe('AgentsService.createVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('promotes a saved version to the active draft spec', async () => {
    const oldSpec = spec({ name: 'Old spec' });
    const nextSpec = spec({
      name: 'Updated spec',
      tools: [
        {
          name: 'record_survey_feedback_crm',
          description: 'Create a CRM contact from survey feedback.',
          requires_confirmation: true,
          permissions: ['crm'],
          input_schema: {
            type: 'object',
            required: ['full_name'],
            properties: {
              full_name: { type: 'string' },
            },
          },
        },
      ],
    });
    const { service, agentUpdate, versionCreate, cacheInvalidator } = makeAgentsServiceWith({
      initialAgent: {
        id: 'agent-1',
        workspaceId: 'w1',
        organizationId: 'org1',
        status: 'draft',
        specJson: oldSpec,
        activeVersionId: 'v1',
        versions: [
          {
            id: 'v1',
            agentId: 'agent-1',
            versionNumber: 1,
            specJson: oldSpec,
            deploymentStatus: 'not_deployed',
            provider: null,
            providerRuntimeId: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            note: null,
          },
        ],
      },
    });

    await service.createVersion('w1', 'agent-1', 'user-1', {
      spec: nextSpec,
      note: 'Updated in builder spec editor',
    });

    expect(versionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: 'agent-1',
          organizationId: 'org1',
          versionNumber: 2,
          specJson: nextSpec,
        }),
      }),
    );
    expect(agentUpdate).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: {
        specJson: nextSpec,
        activeVersionId: 'v-created',
      },
    });
    expect(cacheInvalidator.invalidateAgentList).toHaveBeenCalledWith('w1');
  });
});
