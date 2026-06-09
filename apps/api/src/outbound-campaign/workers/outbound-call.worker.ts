import { BaseWorker } from '../../workers/base.worker';
import { Injectable } from '@nestjs/common';
import { QueueService } from '../../queue/queue.service';
import { OutboundCampaignService } from '../outbound-campaign.service';
import { CallsService } from '../../calls/calls.service';
import { OUTBOUND_CAMPAIGN_QUEUE } from '../outbound-campaign.queue';
import { PrismaService } from '../../prisma/prisma.service';
import { TelephonyService } from '../../telephony/telephony.service';

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
    private readonly prisma: PrismaService,
    private readonly telephony: TelephonyService,
  ) {
    super(OUTBOUND_CAMPAIGN_QUEUE, queueService, 5);
  }

  async processor(job: { data: OutboundCallJob }): Promise<void> {
    const { campaignId, agentId, workspaceId, actorUserId, to, contactName, customData } = job.data;

    try {
      const metadata = {
        campaign_id: campaignId,
        ...customData,
        purpose: 'outbound_campaign',
      };
      const assignedByoNumber = await this.findAssignedByoOutboundNumber(workspaceId, agentId);
      if (assignedByoNumber) {
        const call = await this.telephony.startOutboundCall(workspaceId, actorUserId, {
          phone_number_id: assignedByoNumber.id,
          to_number: to,
          contact_name: contactName,
          metadata,
        });

        await this.campaigns.incrementStat(campaignId, 'in_progress');
        this.logger.log(`Outbound campaign call queued via ${assignedByoNumber.provider}: ${call.call_id} to ${to}`);
        return;
      }

      const call = await this.calls.startOutboundCall(workspaceId, agentId, actorUserId, {
        to_number: to,
        contact_name: contactName,
        metadata,
      });

      await this.campaigns.incrementStat(campaignId, 'in_progress');
      this.logger.log(`Outbound campaign call queued: ${call.id} to ${to}`);
    } catch (err) {
      this.logger.error(`Outbound call failed for ${to}: ${(err as Error).message}`);
      await this.campaigns.incrementStat(campaignId, 'failed');
    }
  }

  private findAssignedByoOutboundNumber(workspaceId: string, agentId: string) {
    return this.prisma.telephonyPhoneNumber.findFirst({
      where: {
        workspaceId,
        assignedAgentId: agentId,
        outboundEnabled: true,
        status: { not: 'disconnected' },
        livekitConfig: {
          is: {
            outboundTrunkId: { not: null },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, provider: true },
    });
  }
}
