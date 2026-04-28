import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import { AgentsService } from './agents.service';
import { AgentSpecInvalidError, AgentNotFoundError } from '../common/errors';

function spec(): AgentSpec {
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
  } as AgentSpec;
}

interface AgentRow {
  id: string;
  workspaceId: string;
  status: string;
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
  const prisma = {
    agent: {
      findFirst: vi.fn(async () => opts.initialAgent),
      update: agentUpdate,
    },
    agentVersion: {
      update: versionUpdate,
    },
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
  const service = new AgentsService(
    prisma as never,
    audit as never,
    generator as never,
    knowledge as never,
    voice as never,
    cache as never,
  );
  // Override `get` so we don't need the secondary findFirst with versions loader.
  service.get = vi.fn(async () => ({
    id: opts.initialAgent?.id ?? 'a',
  })) as never;
  return { service, prisma, voice, agentUpdate, versionUpdate, audit };
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
    const { service, voice } = makeAgentsServiceWith({
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
