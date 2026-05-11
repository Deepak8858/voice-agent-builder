import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../audit/audit.service';
import { GenerateAgentDto } from './dto/generate-agent.dto';
import { GenerationStatus } from './dto/generate-status.dto';

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async startGeneration(
    workspaceId: string,
    actorUserId: string,
    dto: GenerateAgentDto,
  ): Promise<{ agent_id: string; status_url: string }> {
    const organizationId = await this.prisma.organizationIdFor(workspaceId);

    const agent = await this.prisma.agent.create({
      data: {
        workspaceId,
        organizationId,
        name: 'Generating...',
        industry: this.detectIndustry(dto.prompt),
        agentType: this.mapCallDirection(dto.call_direction),
        status: 'draft_generating',
        createdBy: actorUserId,
      },
    });

    await this.queue.enqueue('orchestrator.generate', 'generate', {
      agentId: agent.id,
      workspaceId,
      actorUserId,
      prompt: dto.prompt,
      template_slug: dto.template_slug,
      crm_providers: dto.crm_providers,
      call_direction: dto.call_direction,
      voice_config: dto.voice_config,
    });

    return {
      agent_id: agent.id,
      status_url: `/api/agents/generate/${agent.id}`,
    };
  }

  async getStatus(workspaceId: string, agentId: string): Promise<GenerationStatus> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    if (!agent) throw new Error('Agent not found');

    const activeVersion = agent.versions[0];
    const steps = await this.buildGenerationSteps(agentId, agent.status);

    return {
      agent_id: agent.id,
      status: agent.status as GenerationStatus['status'],
      steps,
      agent_preview: activeVersion?.specJson as GenerationStatus['agent_preview'],
      created_at: agent.createdAt.toISOString(),
      updated_at: agent.updatedAt.toISOString(),
    };
  }

  async publish(workspaceId: string, agentId: string, actorUserId: string): Promise<void> {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { status: 'publishing' },
    });

    await this.queue.enqueue('orchestrator.publish', 'publish', { agentId, workspaceId, actorUserId });
  }

  private detectIndustry(prompt: string): string {
    const keywords: Record<string, string> = {
      dental: 'Healthcare', dentist: 'Healthcare', medical: 'Healthcare', doctor: 'Healthcare',
      hvac: 'Home Services', plumbing: 'Home Services', repair: 'Home Services',
      salon: 'Beauty', spa: 'Beauty', hair: 'Beauty',
      'real estate': 'Real Estate', realtor: 'Real Estate',
      enterprise: 'Enterprise', b2b: 'Enterprise', saas: 'Enterprise',
    };
    const lower = prompt.toLowerCase();
    for (const [kw, industry] of Object.entries(keywords)) {
      if (lower.includes(kw)) return industry;
    }
    return 'General';
  }

  private mapCallDirection(dir: string): string {
    const map: Record<string, string> = {
      inbound: 'inbound_receptionist',
      outbound: 'outbound_reminder',
      both: 'inbound_receptionist',
    };
    return map[dir] ?? 'inbound_receptionist';
  }

  private async buildGenerationSteps(agentId: string, agentStatus: string) {
    const [sources, rules, number] = await Promise.all([
      this.prisma.knowledgeSource.findMany({ where: { agentId }, select: { status: true } }),
      this.prisma.crmRoutingRule.findMany({ where: { agentId }, select: { id: true, provider: true } }),
      this.prisma.twilioPhoneNumber.findFirst({ where: { agentId } }),
    ]);

    const hasSpec = sources.length > 0 || rules.length > 0;
    const doneSources = sources.filter(s => s.status === 'ready').length;

    return {
      spec_generation: {
        status: hasSpec ? 'done' : (agentStatus === 'draft_generating' ? 'pending' : 'done') as 'pending' | 'done',
      },
      doc_ingest: {
        status: sources.length === 0 ? 'pending' : (doneSources === sources.length ? 'done' : 'processing') as 'pending' | 'processing' | 'done',
        progress: doneSources,
        total: sources.length,
      },
      crm_setup: {
        status: rules.length > 0 ? 'done' : 'pending' as 'pending' | 'done',
        providers: rules.map(r => r.provider),
      },
      phone_number: {
        status: number ? 'done' : 'pending' as 'pending' | 'done',
        number: number?.phoneNumber,
      },
      publish: {
        status: 'pending' as 'pending',
      },
    };
  }
}
