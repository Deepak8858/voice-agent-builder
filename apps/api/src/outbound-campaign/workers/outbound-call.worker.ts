import { BaseWorker } from '../../workers/base.worker';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
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

/**
 * Admission denials that mean "not now" rather than "not ever". Retrying the
 * same contact once capacity or credit returns is correct; burning it as a
 * failed dial is not, because the contact was never actually called.
 */
const RETRYABLE_ADMISSION_REASONS: ReadonlySet<string> = new Set([
  'organization_concurrency_reached',
  'platform_concurrency_reached',
  'billing_temporarily_unavailable',
]);

/**
 * Denials that will not resolve without the customer acting. Continuing to dial
 * the rest of the list would produce a wall of identical failures, so the
 * campaign is paused instead.
 */
const BLOCKING_ADMISSION_REASONS: ReadonlySet<string> = new Set([
  'credit_insufficient',
  'subscription_required',
  'subscription_inactive',
]);

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
      await this.handleDispatchFailure(campaignId, to, err);
    }
  }

  /**
   * A billing denial is not a dial failure. Distinguishing them keeps campaign
   * statistics honest and stops a drained balance from silently consuming an
   * entire contact list.
   */
  private async handleDispatchFailure(
    campaignId: string,
    to: string,
    err: unknown,
  ): Promise<void> {
    const reason = this.admissionReason(err);
    const message = (err as Error).message;

    if (reason && RETRYABLE_ADMISSION_REASONS.has(reason)) {
      this.logger.warn(`Outbound campaign call to ${to} deferred (${reason}): ${message}`);
      // Thrown so BullMQ retries the job rather than counting a dial that never
      // happened.
      throw err;
    }

    if (reason && BLOCKING_ADMISSION_REASONS.has(reason)) {
      this.logger.error(`Pausing campaign ${campaignId}: ${reason}`);
      // Stop new dispatches before the non-critical statistics write. A failed
      // counter update must never leave a drained campaign running.
      await this.pauseCampaign(campaignId, reason);
      await this.campaigns.incrementStat(campaignId, 'failed');
      return;
    }

    this.logger.error(`Outbound call failed for ${to}: ${message}`);
    await this.campaigns.incrementStat(campaignId, 'failed');
  }

  private admissionReason(err: unknown): string | null {
    if (!(err instanceof AppError)) return null;
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' ? reason : null;
  }

  private async pauseCampaign(campaignId: string, reason: string): Promise<void> {
    try {
      await this.prisma.outboundCampaign.updateMany({
        where: { id: campaignId, status: 'running' },
        data: { status: 'paused' },
      });
    } catch (err) {
      this.logger.error(
        `Failed to pause campaign ${campaignId} after ${reason}: ${(err as Error).message}`,
      );
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
