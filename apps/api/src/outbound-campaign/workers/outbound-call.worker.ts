import { BaseWorker } from '../../workers/base.worker';
import { Injectable } from '@nestjs/common';
import { QueueService } from '../../queue/queue.service';
import { OutboundCampaignService } from '../outbound-campaign.service';
import { CallsService } from '../../calls/calls.service';
import { OUTBOUND_CAMPAIGN_QUEUE } from '../outbound-campaign.queue';

interface OutboundCallJob {
  campaignId: string;
  agentId: string;
  workspaceId: string;
  actorUserId: string;
  to: string;
  contactName?: string;
  customData?: Record<string, string>;
}

@Injectable()
export class OutboundCallWorker extends BaseWorker<OutboundCallJob> {
  constructor(
    queueService: QueueService,
    private readonly calls: CallsService,
    private readonly campaigns: OutboundCampaignService,
  ) {
    super(OUTBOUND_CAMPAIGN_QUEUE, queueService, 5);
  }

  async processor(job: { data: OutboundCallJob }): Promise<void> {
    const { campaignId, agentId, workspaceId, actorUserId, to, contactName, customData } = job.data;

    try {
      const call = await this.calls.startOutboundCall(workspaceId, agentId, actorUserId, {
        to_number: to,
        contact_name: contactName,
        metadata: {
          campaign_id: campaignId,
          ...customData,
          purpose: 'outbound_campaign',
        },
      });

      await this.campaigns.incrementStat(campaignId, 'in_progress');
      this.logger.log(`Outbound campaign call queued: ${call.id} to ${to}`);
    } catch (err) {
      this.logger.error(`Outbound call failed for ${to}: ${(err as Error).message}`);
      await this.campaigns.incrementStat(campaignId, 'failed');
    }
  }
}
