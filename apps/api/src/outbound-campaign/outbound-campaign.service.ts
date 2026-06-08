import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AgentNotFoundError, AppError } from '../common/errors';
import type { Prisma } from '@prisma/client';
import { OUTBOUND_CAMPAIGN_QUEUE } from './outbound-campaign.queue';
import { AuditService } from '../audit/audit.service';

export interface CampaignContact {
  phone: string;
  full_name?: string;
  email?: string;
  custom_data?: Record<string, string>;
}

@Injectable()
export class OutboundCampaignService {
  private readonly logger = new Logger(OutboundCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.outboundCampaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    dto: {
      agent_id: string;
      name: string;
      contacts: CampaignContact[];
      schedule?: Record<string, unknown>;
    },
  ) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: dto.agent_id, workspaceId },
      select: { id: true },
    });
    if (!agent) throw new AgentNotFoundError(dto.agent_id);

    const campaign = await this.prisma.outboundCampaign.create({
      data: {
        workspaceId,
        agentId: dto.agent_id,
        name: dto.name,
        contacts: dto.contacts as unknown as Prisma.InputJsonValue,
        schedule: (dto.schedule ?? { max_calls_per_hour: 10, max_concurrent: 3 }) as Prisma.InputJsonValue,
        status: 'draft',
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'campaign.create',
      resourceType: 'outbound_campaign',
      resourceId: campaign.id,
      metadata: {
        agent_id: dto.agent_id,
        contact_count: dto.contacts.length,
      },
    });
    return campaign;
  }

  async start(workspaceId: string, campaignId: string, actorUserId: string) {
    const campaign = await this.prisma.outboundCampaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!campaign) throw new AppError('NOT_FOUND', 'Campaign not found', 404);
    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      throw new AppError('INVALID_STATUS', `Cannot start campaign in ${campaign.status} status`, 400);
    }

    await this.prisma.outboundCampaign.update({
      where: { id: campaignId },
      data: {
        status: 'running',
        stats: { total: (campaign.contacts as unknown as { length: number }).length, completed: 0, failed: 0, in_progress: 0 },
      },
    });

    const contacts = (campaign.contacts as unknown as CampaignContact[]) ?? [];
    for (const contact of contacts) {
      await this.queue.enqueue(OUTBOUND_CAMPAIGN_QUEUE, 'call', {
        campaignId,
        agentId: campaign.agentId,
        workspaceId: campaign.workspaceId,
        actorUserId,
        to: contact.phone,
        contactName: contact.full_name,
        customData: contact.custom_data,
      });
    }

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'campaign.start',
      resourceType: 'outbound_campaign',
      resourceId: campaignId,
      metadata: {
        agent_id: campaign.agentId,
        contact_count: contacts.length,
      },
    });

    this.logger.log(`Campaign ${campaignId} started with ${contacts.length} contacts`);
  }

  async pause(workspaceId: string, campaignId: string, actorUserId: string) {
    const result = await this.prisma.outboundCampaign.updateMany({
      where: { id: campaignId, workspaceId },
      data: { status: 'paused' },
    });
    if (result.count === 0) throw new AppError('NOT_FOUND', 'Campaign not found', 404);
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'campaign.pause',
      resourceType: 'outbound_campaign',
      resourceId: campaignId,
    });
  }

  async getStats(workspaceId: string, campaignId: string) {
    const campaign = await this.prisma.outboundCampaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    return campaign?.stats;
  }

  async getCampaign(workspaceId: string, campaignId: string) {
    return this.prisma.outboundCampaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
  }

  async incrementStat(campaignId: string, field: 'completed' | 'failed' | 'in_progress') {
    const campaign = await this.prisma.outboundCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return;
    const stats = campaign.stats as Record<string, number>;
    stats[field] = (stats[field] ?? 0) + 1;
    await this.prisma.outboundCampaign.update({
      where: { id: campaignId },
      data: { stats },
    });
  }
}
