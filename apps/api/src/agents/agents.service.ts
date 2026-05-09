import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
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
      active_spec: activeVersion ? ((activeVersion.specJson as unknown) as AgentSpec) : null,
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
    const latest = agent.versions[0];
    if (!latest) throw new AgentSpecInvalidError({ reason: 'No versions to publish.' });

    // Re-validate latest spec before publishing.
    const parsed = AgentSpecSchema.safeParse(latest.specJson);
    if (!parsed.success) throw new AgentSpecInvalidError({ issues: parsed.error.flatten() });

    let providerRuntimeId = latest.providerRuntimeId;
    let deploymentStatus: 'deployed' | 'failed' = 'deployed';
    let deployError: string | null = null;
    try {
      if (providerRuntimeId) {
        await this.voice.updateAgent({
          workspaceId,
          agentId,
          agentVersionId: latest.id,
          spec: parsed.data,
          provider_runtime_id: providerRuntimeId,
        });
      } else {
        const created = await this.voice.createAgent({
          workspaceId,
          agentId,
          agentVersionId: latest.id,
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
        activeVersionId: deploymentStatus === 'deployed' ? latest.id : agent.activeVersionId,
      },
    });
    await this.prisma.agentVersion.update({
      where: { id: latest.id },
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
        version_id: latest.id,
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
    body: { nodes?: unknown[]; edges?: unknown[] },
  ): Promise<AgentDetail> {
    const agent = await this.prisma.agent.findFirstOrThrow({ where: { id: agentId, workspaceId } });
    const spec = (agent.specJson ?? {}) as Record<string, unknown>;
    const flowNodes = (body.nodes as Array<{ id: string; type: string; data: unknown }>).map((n) => ({
      id: n.id,
      type: n.type,
      ...((n.data as Record<string, unknown>) ?? {}),
    }));
    spec['flow'] = {
      nodes: flowNodes,
      start_node_id: flowNodes.find((n) => n.type === 'start')?.id ?? flowNodes[0]?.id,
    };

    await this.prisma.agent.update({
      where: { id: agentId },
      data: { specJson: spec as Prisma.InputJsonValue },
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
