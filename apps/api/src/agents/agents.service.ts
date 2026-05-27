import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AgentDetail,
  AgentSpec,
  AgentSummary,
  CreateAgentDto,
  CreateAgentVersionDto,
  GenerateAgentDto,
  GenerateAgentResult,
  UpdateAgentDto,
} from '@voiceforge/shared';
import { AgentSpecSchema } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { AgentNotFoundError, AgentSpecInvalidError } from '../common/errors';
import { CacheInvalidator } from '../common/cache-invalidator';
import { CacheService } from '../cache/cache.service';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from '../llm/llm.provider.interface';
import { VOICE_PROVIDER_TOKEN } from '../voice/voice.module';
import type { VoiceRuntimeProvider } from '../voice/adapters/voice.provider.interface';
import { BillingService } from '../billing/billing.service';

export interface ListAgentsResult {
  agents: AgentSummary[];
  fromCache: boolean;
}

export type FlowSaveNode = {
  id: string;
  type: string;
  data: unknown;
};

export type FlowSaveEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

export type UpdateFlowBody = {
  nodes: FlowSaveNode[];
  edges: FlowSaveEdge[];
};

type AgentFlow = NonNullable<AgentSpec['flow']>;
type AgentFlowNode = AgentFlow['nodes'][number];

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly generator: LlmAgentGenerator,
    private readonly knowledge: KnowledgeService,
    @Inject(VOICE_PROVIDER_TOKEN) private readonly voice: VoiceRuntimeProvider,
    private readonly cache: CacheService,
    private readonly cacheInvalidator: CacheInvalidator,
    private readonly billing: BillingService,
  ) {}

  async generate(workspaceId: string, dto: GenerateAgentDto): Promise<GenerateAgentResult> {
    const requested = dto.knowledge_source_ids ?? [];
    const validIds =
      requested.length > 0
        ? await this.knowledge.resolveReferencedSourceIds(workspaceId, null, requested)
        : [];
    return this.generator.generate({ ...dto, knowledge_source_ids: validIds });
  }

  getStreamingGenerator(): ((input: GenerateAgentDto) => AsyncGenerator<string>) | null {
    if (typeof this.generator.generateStream === 'function') {
      return this.generator.generateStream as (input: GenerateAgentDto) => AsyncGenerator<string>;
    }
    return null;
  }

  async list(workspaceId: string): Promise<ListAgentsResult> {
    const key = `agents:list:${workspaceId}`;
    const cached = await this.cache.get<AgentSummary[]>(key);
    if (cached !== null) {
      return { agents: cached, fromCache: true };
    }
    const agents = await this.prisma.agent.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    const summaries = agents.map((a) => this.toSummary(a));
    await this.cache.set(key, summaries, 60);
    return { agents: summaries, fromCache: false };
  }

  async get(workspaceId: string, agentId: string): Promise<AgentDetail> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      include: { versions: { orderBy: { versionNumber: 'desc' } } },
    });
    if (!agent) throw new AgentNotFoundError(agentId);
    const activeVersion = agent.versions.find((v) => v.id === agent.activeVersionId) ?? null;
    const activeSpec = agent.specJson ?? activeVersion?.specJson ?? null;
    return {
      ...this.toSummary(agent),
      versions: agent.versions.map((v) => ({
        id: v.id,
        agent_id: v.agentId,
        version_number: v.versionNumber,
        deployment_status: v.deploymentStatus as AgentDetail['versions'][number]['deployment_status'],
        provider: v.provider,
        provider_runtime_id: v.providerRuntimeId,
        created_at: v.createdAt.toISOString(),
        note: v.note,
      })),
      active_spec: activeSpec ? ((activeSpec as unknown) as AgentSpec) : null,
    };
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    dto: CreateAgentDto,
  ): Promise<AgentDetail> {
    let initialSpec: AgentSpec | null = null;
    if (dto.spec) {
      const parsed = AgentSpecSchema.safeParse(dto.spec);
      if (!parsed.success) throw new AgentSpecInvalidError({ issues: parsed.error.flatten() });
      initialSpec = parsed.data;
    }

    const organizationId = await this.prisma.organizationIdFor(workspaceId);

    const { agent, firstVersion } = await this.prisma.$transaction(async (tx) => {
      const agent = await tx.agent.create({
        data: {
          workspaceId,
          organizationId,
          name: dto.name,
          description: dto.description,
          industry: dto.industry,
          agentType: dto.agent_type,
          ...(initialSpec ? { specJson: initialSpec as unknown as object } : {}),
          createdBy: actorUserId,
        },
      });
      let firstVersion = null as Awaited<ReturnType<typeof tx.agentVersion.create>> | null;
      if (initialSpec) {
        firstVersion = await tx.agentVersion.create({
          data: {
            agentId: agent.id,
            organizationId,
            versionNumber: 1,
            specJson: initialSpec as unknown as object,
            createdBy: actorUserId,
          },
        });
        await tx.agent.update({
          where: { id: agent.id },
          data: { activeVersionId: firstVersion.id },
        });
      }
      return { agent, firstVersion };
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'agent.create',
      resourceType: 'agent',
      resourceId: agent.id,
      metadata: { name: agent.name, has_initial_spec: Boolean(firstVersion) },
    });

    await this.cacheInvalidator.invalidateAgentList(workspaceId);

    // Phase 9: warn at 80% agent creation capacity
    try {
      const w = await this.billing.checkAgentCreationWarning(organizationId);
      if (w.warning) {
        this.logger.warn(`Agent creation warning for org ${organizationId}: ${w.warning}`);
      }
    } catch {}

    return this.get(workspaceId, agent.id);
  }

  async update(
    workspaceId: string,
    agentId: string,
    actorUserId: string,
    dto: UpdateAgentDto,
  ): Promise<AgentDetail> {
    const existing = await this.prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
    if (!existing) throw new AgentNotFoundError(agentId);
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        name: dto.name ?? existing.name,
        description: dto.description ?? existing.description,
        industry: dto.industry ?? existing.industry,
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'agent.update',
      resourceType: 'agent',
      resourceId: agentId,
      metadata: dto as Record<string, unknown>,
    });

    await this.cacheInvalidator.invalidateAgentList(workspaceId);

    return this.get(workspaceId, agentId);
  }

  async createVersion(
    workspaceId: string,
    agentId: string,
    actorUserId: string,
    dto: CreateAgentVersionDto,
  ): Promise<AgentDetail> {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
    if (!agent) throw new AgentNotFoundError(agentId);

    const parsed = AgentSpecSchema.safeParse(dto.spec);
    if (!parsed.success) throw new AgentSpecInvalidError({ issues: parsed.error.flatten() });

    const last = await this.prisma.agentVersion.findFirst({
      where: { agentId },
      orderBy: { versionNumber: 'desc' },
    });
    const nextNumber = (last?.versionNumber ?? 0) + 1;

    const organizationId = await this.prisma.organizationIdFor(workspaceId);

    const created = await this.prisma.agentVersion.create({
      data: {
        agentId,
        organizationId,
        versionNumber: nextNumber,
        specJson: parsed.data as unknown as object,
        note: dto.note,
        createdBy: actorUserId,
      },
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'agent.version.create',
      resourceType: 'agent_version',
      resourceId: created.id,
      metadata: { version_number: nextNumber },
    });

    return this.get(workspaceId, agentId);
  }

  async publish(workspaceId: string, agentId: string, actorUserId: string): Promise<AgentDetail> {
    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    await this.billing.enforceAgentLimit(ws.organizationId);

    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!agent) throw new AgentNotFoundError(agentId);
    const latest = agent.versions[0] ?? null;
    const specToPublish = agent.specJson ?? latest?.specJson ?? null;
    if (!specToPublish) throw new AgentSpecInvalidError({ reason: 'No versions to publish.' });

    // Re-validate latest spec before publishing.
    const parsed = AgentSpecSchema.safeParse(specToPublish);
    if (!parsed.success) throw new AgentSpecInvalidError({ issues: parsed.error.flatten() });

    let versionToPublish = latest;
    if (agent.specJson && (!latest || !jsonValuesEqual(agent.specJson, latest.specJson))) {
      const nextNumber = (latest?.versionNumber ?? 0) + 1;
      versionToPublish = await this.prisma.agentVersion.create({
        data: {
          agentId,
          organizationId: agent.organizationId,
          versionNumber: nextNumber,
          specJson: parsed.data as unknown as object,
          note: 'Published from builder draft',
          createdBy: actorUserId,
        },
      });
      await this.audit.log({
        workspaceId,
        actorUserId,
        action: 'agent.version.create',
        resourceType: 'agent_version',
        resourceId: versionToPublish.id,
        metadata: { version_number: nextNumber, source: 'publish_draft' },
      });
    }
    if (!versionToPublish) throw new AgentSpecInvalidError({ reason: 'No versions to publish.' });

    let providerRuntimeId = versionToPublish.providerRuntimeId;
    let deploymentStatus: 'deployed' | 'failed' = 'deployed';
    let deployError: string | null = null;
    try {
      if (providerRuntimeId) {
        await this.voice.updateAgent({
          workspaceId,
          agentId,
          agentVersionId: versionToPublish.id,
          spec: parsed.data,
          provider_runtime_id: providerRuntimeId,
        });
      } else {
        const created = await this.voice.createAgent({
          workspaceId,
          agentId,
          agentVersionId: versionToPublish.id,
          spec: parsed.data,
        });
        providerRuntimeId = created.provider_runtime_id;
      }
    } catch (err) {
      deploymentStatus = 'failed';
      deployError = err instanceof Error ? err.message : String(err);
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        status: deploymentStatus === 'deployed' ? 'published' : agent.status,
        activeVersionId: deploymentStatus === 'deployed' ? versionToPublish.id : agent.activeVersionId,
      },
    });
    await this.prisma.agentVersion.update({
      where: { id: versionToPublish.id },
      data: {
        deploymentStatus,
        provider: this.voice.name,
        providerRuntimeId,
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'agent.publish',
      resourceType: 'agent',
      resourceId: agentId,
      metadata: {
        version_id: versionToPublish.id,
        provider: this.voice.name,
        provider_runtime_id: providerRuntimeId,
        deployment_status: deploymentStatus,
        ...(deployError ? { error: deployError } : {}),
      },
    });
    if (deploymentStatus === 'failed') {
      throw new AgentSpecInvalidError({ reason: `Voice provider deploy failed: ${deployError}` });
    }

    await this.cacheInvalidator.invalidateAgentList(workspaceId);

    return this.get(workspaceId, agentId);
  }

  async pause(workspaceId: string, agentId: string, actorUserId: string): Promise<AgentDetail> {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, workspaceId } });
    if (!agent) throw new AgentNotFoundError(agentId);
    await this.prisma.agent.update({ where: { id: agentId }, data: { status: 'paused' } });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'agent.pause',
      resourceType: 'agent',
      resourceId: agentId,
    });

    await this.cacheInvalidator.invalidateAgentList(workspaceId);

    return this.get(workspaceId, agentId);
  }

  async updateFlow(
    workspaceId: string,
    agentId: string,
    actorUserId: string,
    body: UpdateFlowBody,
  ): Promise<AgentDetail> {
    const agent = await this.prisma.agent.findFirstOrThrow({
      where: { id: agentId, workspaceId },
      include: { versions: { orderBy: { versionNumber: 'desc' } } },
    });
    const activeVersionSpec = agent.activeVersionId
      ? agent.versions.find((v) => v.id === agent.activeVersionId)?.specJson
      : null;
    const baseSpec = agent.specJson ?? activeVersionSpec ?? agent.versions[0]?.specJson ?? null;
    if (!baseSpec) {
      throw new AgentSpecInvalidError({
        reason: 'Agent has no Agent Spec JSON to attach a conversation flow to.',
      });
    }

    const spec = {
      ...((baseSpec as Record<string, unknown>) ?? {}),
      flow: buildAgentFlow(body.nodes, body.edges),
    };

    const parsed = AgentSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new AgentSpecInvalidError({ issues: parsed.error.flatten() });
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: { specJson: parsed.data as unknown as Prisma.InputJsonValue },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'agent.flow.updated',
      resourceType: 'agent',
      resourceId: agentId,
    });
    return this.get(workspaceId, agentId);
  }

  private toSummary(a: {
    id: string;
    workspaceId: string;
    name: string;
    description: string | null;
    industry: string;
    agentType: string;
    status: string;
    activeVersionId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): AgentSummary {
    return {
      id: a.id,
      workspace_id: a.workspaceId,
      name: a.name,
      description: a.description,
      industry: a.industry,
      agent_type: a.agentType as AgentSummary['agent_type'],
      status: a.status as AgentSummary['status'],
      active_version_id: a.activeVersionId,
      created_at: a.createdAt.toISOString(),
      updated_at: a.updatedAt.toISOString(),
    };
  }
}

function buildAgentFlow(nodes: FlowSaveNode[], edges: FlowSaveEdge[]): AgentFlow {
  const outgoing = new Map<string, FlowSaveEdge[]>();
  for (const edge of edges) {
    const existing = outgoing.get(edge.source) ?? [];
    existing.push(edge);
    outgoing.set(edge.source, existing);
  }

  const flowNodes = nodes.map((node) => toAgentFlowNode(node, outgoing));
  return {
    nodes: flowNodes,
    start_node_id: flowNodes.find((n) => n.type === 'start')?.id ?? flowNodes[0]?.id ?? '',
  };
}

function toAgentFlowNode(
  node: FlowSaveNode,
  outgoing: Map<string, FlowSaveEdge[]>,
): AgentFlowNode {
  const data = asRecord(node.data);
  const label = optionalString(data['label']);
  const next = nextTarget(node.id, outgoing);
  const base = {
    id: node.id,
    ...(label ? { label } : {}),
  };

  switch (normalizeFlowType(node.type)) {
    case 'start':
      return { ...base, type: 'start', ...(next ? { next } : {}) };
    case 'speak':
      return {
        ...base,
        type: 'speak',
        text: stringValue(data['text']),
        ...(next ? { next } : {}),
      };
    case 'ask_question':
      return {
        ...base,
        type: 'ask_question',
        question: stringValue(data['question']),
        ...(optionalString(data['capture_field'])
          ? { capture_field: optionalString(data['capture_field']) }
          : {}),
        ...(next ? { next } : {}),
      };
    case 'condition':
      return {
        ...base,
        type: 'condition',
        expression: stringValue(data['expression']),
        on_true: branchTarget(node.id, outgoing, 'true') ?? stringValue(data['on_true']),
        on_false: branchTarget(node.id, outgoing, 'false') ?? stringValue(data['on_false']),
      };
    case 'knowledge_lookup':
      return {
        ...base,
        type: 'knowledge_lookup',
        ...(optionalString(data['query_field'])
          ? { query_field: optionalString(data['query_field']) }
          : {}),
        ...(next ? { next } : {}),
      };
    case 'tool_call':
      return {
        ...base,
        type: 'tool_call',
        tool_name: stringValue(data['tool_name']),
        ...(asRecordOrNull(data['arguments']) ? { arguments: asRecord(data['arguments']) } : {}),
        ...(next ? { next } : {}),
      };
    case 'transfer':
      return {
        ...base,
        type: 'transfer',
        ...(optionalString(data['target_phone'])
          ? { target_phone: optionalString(data['target_phone']) }
          : {}),
        ...(next ? { next } : {}),
      };
    case 'send_message':
      return {
        ...base,
        type: 'send_message',
        channel: data['channel'] === 'email' ? 'email' : 'sms',
        body: stringValue(data['body']),
        ...(next ? { next } : {}),
      };
    case 'fallback':
      return {
        ...base,
        type: 'fallback',
        ...(optionalString(data['message']) ? { message: optionalString(data['message']) } : {}),
        ...(next ? { next } : {}),
      };
    case 'end':
    default:
      return { ...base, type: 'end' };
  }
}

function normalizeFlowType(type: string): string {
  if (type === 'ask-question') return 'ask_question';
  if (type === 'tool-call') return 'tool_call';
  return type;
}

function nextTarget(nodeId: string, outgoing: Map<string, FlowSaveEdge[]>): string | undefined {
  const edges = outgoing.get(nodeId) ?? [];
  const edge = edges.find((candidate) => !isConditionHandle(candidate.sourceHandle)) ?? edges[0];
  return edge?.target;
}

function branchTarget(
  nodeId: string,
  outgoing: Map<string, FlowSaveEdge[]>,
  branch: 'true' | 'false',
): string | undefined {
  return (outgoing.get(nodeId) ?? []).find((edge) => edge.sourceHandle === branch)?.target;
}

function isConditionHandle(handle: string | null | undefined): boolean {
  return handle === 'true' || handle === 'false';
}

function asRecord(value: unknown): Record<string, unknown> {
  return asRecordOrNull(value) ?? {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
