import { type Job } from 'bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  LLM_PROVIDER_TOKEN,
  type LlmAgentGenerator,
} from '../llm/llm.provider.interface';
import { CrmRoutingService } from '../crm-routing/crm-routing.service';

export const ORCHESTRATOR_QUEUE = 'orchestrator';

interface GenerateJob {
  agentId: string;
  workspaceId: string;
  actorUserId: string;
  prompt: string;
  template_slug?: string;
  crm_providers: Array<'pipedrive' | 'hubspot' | 'salesforce' | 'generic_webhook'>;
  call_direction: 'inbound' | 'outbound' | 'both';
  voice_config?: {
    provider?: 'deepgram' | 'elevenlabs' | 'custom';
    voice_id?: string;
    language?: string;
    stability?: number;
  };
}

interface PublishJob {
  agentId: string;
  workspaceId: string;
  actorUserId: string;
}

@Injectable()
export class OrchestratorWorker extends BaseWorker<GenerateJob | PublishJob> {
  constructor(
    queueService: QueueService,
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmAgentGenerator,
    private readonly routing: CrmRoutingService,
  ) {
    super(ORCHESTRATOR_QUEUE, queueService, 2);
  }

  async processor(job: Job<GenerateJob | PublishJob>): Promise<void> {
    if (job.name === 'generate') {
      await this.handleGenerate(job as Job<GenerateJob>);
    } else if (job.name === 'publish') {
      await this.handlePublish(job as Job<PublishJob>);
    }
  }

  private async handleGenerate(job: Job<GenerateJob>): Promise<void> {
    const { agentId, workspaceId, prompt, crm_providers, template_slug, voice_config } = job.data;

    try {
      this.logger.log(`[generate] agent=${agentId} — generating spec`);
      await this.prisma.agent.update({ where: { id: agentId }, data: { status: 'draft_generating' } });

      // Step 1: call LLM to generate agent spec
      const result = await this.llm.generate({
        prompt,
        template_slug,
      });

      // Step 2: save the version
      const specObj = result.spec as Record<string, unknown>;
      await this.prisma.agentVersion.create({
        data: {
          agentId,
          versionNumber: 1,
          specJson: result.spec as object,
        },
      });

      // Step 3: update agent name and status
      await this.prisma.agent.update({
        where: { id: agentId },
        data: {
          name: specObj['name'] as string ?? 'Generated Agent',
          status: 'draft_docs_ready',
        },
      });

      // Step 4: CRM routing rules
      if (crm_providers.length > 0) {
        this.logger.log(`[generate] agent=${agentId} — setting up CRM routing`);
        await Promise.allSettled(
          crm_providers.map((provider) =>
            this.routing.createRule(workspaceId, {
              keyword: 'default',
              provider,
              action: 'primary',
              agent_id: agentId,
            }),
          ),
        );
      }

      await this.prisma.agent.update({ where: { id: agentId }, data: { status: 'draft_crm_ready' } });
      this.logger.log(`[generate] agent=${agentId} — done`);
    } catch (err) {
      this.logger.error(`[generate] agent=${agentId} failed: ${(err as Error).message}`);
      await this.prisma.agent.update({ where: { id: agentId }, data: { status: 'failed' } });
      throw err;
    }
  }

  private async handlePublish(job: Job<PublishJob>): Promise<void> {
    const { agentId, workspaceId, actorUserId } = job.data;

    try {
      this.logger.log(`[publish] agent=${agentId} — publishing`);
      await this.prisma.agent.update({ where: { id: agentId }, data: { status: 'publishing' } });

      // Assign an unassigned Twilio phone number to this agent
      const number = await this.prisma.twilioPhoneNumber.findFirst({
        where: { workspaceId, agentId: null, status: 'active' },
      });
      if (number) {
        await this.prisma.twilioPhoneNumber.update({
          where: { id: number.id },
          data: { agentId },
        });
      }

      await this.prisma.agent.update({
        where: { id: agentId },
        data: {
          status: 'published',
        },
      });

      await this.prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId,
          action: 'agent.published',
          resourceType: 'agent',
          resourceId: agentId,
        },
      });

      this.logger.log(`[publish] agent=${agentId} — published`);
    } catch (err) {
      this.logger.error(`[publish] agent=${agentId} failed: ${(err as Error).message}`);
      await this.prisma.agent.update({ where: { id: agentId }, data: { status: 'failed' } });
      throw err;
    }
  }
}