import { BaseWorker } from '../../workers/base.worker';
import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../../queue/queue.service';
import { TwilioVoiceAdapter } from '../../twilio-adapter/twilio.adapter';
import { OutboundCampaignService } from '../outbound-campaign.service';
import { PrismaService } from '../../prisma/prisma.service';

interface OutboundCallJob {
  campaignId: string;
  agentId: string;
  workspaceId: string;
  to: string;
  contactName?: string;
  customData?: Record<string, string>;
}

@Injectable()
export class OutboundCallWorker extends BaseWorker<OutboundCallJob> {
  constructor(
    queueService: QueueService,
    private readonly twilioAdapter: TwilioVoiceAdapter,
    private readonly campaigns: OutboundCampaignService,
    private readonly prisma: PrismaService,
  ) {
    super('outbound_call', queueService, 5);
  }

  async processor(job: { data: OutboundCallJob }): Promise<void> {
    const { campaignId, agentId, workspaceId, to, contactName, customData } = job.data;

    // Get active version for this agent
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId },
      select: { activeVersionId: true },
    });

    try {
      const result = await this.twilioAdapter.startOutboundCall({
        workspaceId,
        agentId,
        agentVersionId: agent?.activeVersionId ?? '',
        toNumber: to,
        contactName,
        metadata: { campaignId, ...customData },
      });

      // Create call record
      await this.prisma.call.create({
        data: {
          workspaceId,
          agentId,
          direction: 'outbound',
          status: 'queued',
          provider: 'twilio',
          providerCallId: result.provider_call_id,
          toNumber: to,
          contactName,
          metadata: { campaignId, ...customData },
        },
      });

      await this.campaigns.incrementStat(campaignId, 'in_progress');
      this.logger.log(`Outbound call queued: ${result.provider_call_id} to ${to}`);
    } catch (err) {
      this.logger.error(`Outbound call failed for ${to}: ${(err as Error).message}`);
      await this.campaigns.incrementStat(campaignId, 'failed');
    }
  }
}
