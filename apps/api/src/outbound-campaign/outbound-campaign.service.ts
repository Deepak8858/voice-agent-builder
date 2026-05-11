import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AppError } from '../common/errors';
import type { Prisma } from '@prisma/client';

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
  ) {}

  async list(workspaceId: string) {
    return this.prisma.outboundCampaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    workspaceId: string,
    dto: {
      agent_id: string;
      name: string;
      contacts: CampaignContact[];
      schedule?: Record<string, unknown>;
    },
  ) {
    return this.prisma.outboundCampaign.create({
      data: {
        workspaceId,
        agentId: dto.agent_id,
        name: dto.name,
        contacts: dto.contacts as unknown as Prisma.InputJsonValue,
        schedule: (dto.schedule ?? { max_calls_per_hour: 10, max_concurrent: 3 }) as Prisma.InputJsonValue,
        status: 'draft',
      },
    });
  }

  async start(campaignId: string) {
    const campaign = await this.prisma.outboundCampaign.findUnique({ where: { id: campaignId } });
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
      await this.queue.enqueue('outbound.call', 'call', {
        campaignId,
        agentId: campaign.agentId,
        workspaceId: campaign.workspaceId,
        to: contact.phone,
        contactName: contact.full_name,
        customData: contact.custom_data,
      });
    }

    this.logger.log(`Campaign ${campaignId} started with ${contacts.length} contacts`);
  }

  async pause(campaignId: string) {
    await this.prisma.outboundCampaign.update({
      where: { id: campaignId },
      data: { status: 'paused' },
    });
  }

  async getStats(campaignId: string) {
    const campaign = await this.prisma.outboundCampaign.findUnique({ where: { id: campaignId } });
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
    if (field === 'in_progress') {
      stats['in_progress'] = Math.max(0, stats['in_progress'] - 1);
    }
    await this.prisma.outboundCampaign.update({
      where: { id: campaignId },
      data: { stats },
    });
  }
}
