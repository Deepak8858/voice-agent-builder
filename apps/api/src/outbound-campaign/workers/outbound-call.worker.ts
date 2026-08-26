import { BaseWorker } from '../../workers/base.worker';
import { Injectable } from '@nestjs/common';
import type { EntitlementReason } from '@voiceforge/shared';
import { EntitlementReasonSchema } from '@voiceforge/shared';
import { AuditService } from '../../audit/audit.service';
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
 *
 * Typed against the shared reason union rather than loose strings, so renaming
 * a reason in the billing contract fails the build here instead of silently
 * routing a denial into the generic branch.
 */
export const RETRYABLE_ADMISSION_REASONS: ReadonlySet<EntitlementReason> = new Set<EntitlementReason>([
  'organization_concurrency_reached',
  'platform_concurrency_reached',
  'billing_temporarily_unavailable',
]);

/**
 * Denials that will not resolve without the customer acting. Continuing to dial
 * the rest of the list would produce a wall of identical failures, so the
 * campaign is paused instead.
 */
export const BLOCKING_ADMISSION_REASONS: ReadonlySet<EntitlementReason> = new Set<EntitlementReason>([
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
    private readonly audit: AuditService,
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
      await this.handleDispatchFailure(campaignId, workspaceId, to, err);
    }
  }

  /**
   * A billing denial is not a dial failure. Distinguishing them keeps campaign
   * statistics honest and stops a drained balance from silently consuming an
   * entire contact list.
   */
  private async handleDispatchFailure(
    campaignId: string,
    workspaceId: string,
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
      await this.pauseCampaign(campaignId, workspaceId, reason);
      await this.campaigns.incrementStat(campaignId, 'failed');
      return;
    }

    this.logger.error(`Outbound call failed for ${to}: ${message}`);
    await this.campaigns.incrementStat(campaignId, 'failed');
  }

  /** Parsed against the shared contract so an unknown reason is not trusted. */
  private admissionReason(err: unknown): EntitlementReason | null {
    if (!(err instanceof AppError)) return null;
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    const parsed = EntitlementReasonSchema.safeParse(reason);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Pausing is customer-visible state driven by a billing decision, so it is
   * scoped to the owning workspace, audited, and allowed to fail the job.
   *
   * The update is deliberately not swallowed: if it rejects, BullMQ must not
   * acknowledge the job, because acknowledging would leave a campaign marked
   * `running` that nothing will stop.
   */
  private async pauseCampaign(
    campaignId: string,
    workspaceId: string,
    reason: EntitlementReason,
  ): Promise<void> {
    let paused: { count: number };
    try {
      paused = await this.prisma.outboundCampaign.updateMany({
        where: { id: campaignId, workspaceId, status: 'running' },
        data: { status: 'paused' },
      });
    } catch (err) {
      this.logger.error(
        `Failed to pause campaign ${campaignId} after ${reason}: ${(err as Error).message}`,
      );
      throw err;
    }

    // Another delivery already paused it; that delivery owns the audit record.
    if (paused.count === 0) return;

    try {
      await this.audit.log({
        workspaceId,
        action: 'billing.campaign_paused',
        resourceType: 'outbound_campaign',
        resourceId: campaignId,
        metadata: { reason, pausedBy: 'outbound_call_worker' },
      });
    } catch (err) {
      // The campaign is already stopped, which is the safety-critical part. A
      // missing audit row must not resurrect the dispatch loop by failing the
      // job, so it is reported and the pause stands.
      this.logger.error(
        `Campaign ${campaignId} paused for ${reason} but the audit record failed: ${(err as Error).message}`,
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
