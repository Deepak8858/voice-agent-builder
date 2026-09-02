import { BaseWorker } from '../../workers/base.worker';
import { Injectable } from '@nestjs/common';
import type { EntitlementReason } from '@voiceforge/shared';
import { EntitlementReasonSchema } from '@voiceforge/shared';
import { AuditService } from '../../audit/audit.service';
import { AppError } from '../../common/errors';
import { QueueService } from '../../queue/queue.service';
import { HOUR_MS, LIVE_CALL_STATUSES, OutboundCampaignService } from '../outbound-campaign.service';
import { CallsService } from '../../calls/calls.service';
import { OUTBOUND_CAMPAIGN_QUEUE } from '../outbound-campaign.queue';
import { PrismaService } from '../../prisma/prisma.service';
import { TelephonyService } from '../../telephony/telephony.service';

interface OutboundCallJob {
  campaignId: string;
  agentId: string;
  workspaceId: string;
  /**
   * Consent-based compliance purpose from the campaign row. Optional because
   * jobs enqueued before the column existed are still in the queue across a
   * deploy; those dial under the safest allowed purpose.
   */
  purpose?: string;
  actorUserId: string;
  to: string;
  contactName?: string;
  customData?: Record<string, string>;
  /**
   * Position in the campaign's contact list. Optional because jobs enqueued by
   * the previous batch-everything dispatcher are still in the queue across a
   * deploy; those dial normally but drive no chaining or pacing.
   */
  contactIndex?: number;
  dispatchToken?: number;
}

/**
 * How long to wait before retrying a contact that could not be dialled *yet* -
 * the campaign is at `max_concurrent`, or the organization is momentarily out of
 * capacity. Re-queued rather than thrown, so a condition that outlasts the retry
 * budget cannot end the dispatch chain and abandon the rest of the list.
 */
export const DEFER_MS = 30_000;

/**
 * A closed call window reopens on a clock boundary, not on capacity, so it is
 * polled far less often. The contact is held rather than burned: the alternative
 * is a campaign that spends the night recording the whole remaining list as
 * failed dials.
 */
export const CALL_WINDOW_DEFER_MS = 15 * 60_000;

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
    const {
      campaignId,
      agentId,
      workspaceId,
      actorUserId,
      to,
      contactIndex,
      dispatchToken,
    } = job.data;

    const campaign = await this.campaigns.getCampaign(workspaceId, campaignId);
    // A paused, completed or deleted campaign must not dial. The dispatcher
    // enqueues one contact at a time, so returning here also ends the chain, and
    // the persisted cursor is where a restart resumes from.
    if (!campaign || campaign.status !== 'running') {
      this.logger.log(
        `Skipping campaign ${campaignId} dial to ${to}: status ${campaign?.status ?? 'missing'}`,
      );
      return;
    }

    const { maxCallsPerHour, maxConcurrent } = this.campaigns.readSchedule(campaign.schedule);
    const index = contactIndex;
    const token = dispatchToken ?? Date.now();

    // A link left over from an earlier run of this campaign. Pausing does not
    // remove jobs that are already delayed, so a restart can leave one of those
    // behind the resumed chain; dialling it would repeat a call already made and
    // then fork a second chain down the rest of the list.
    //
    // ponytail: two deliveries for the same index picked up in the same instant
    // both pass this. The 60s outbound dedupe in CallsService stops the second
    // dial; a generation column on the campaign would close it outright.
    if (index !== undefined && index < campaign.dispatchedCount) {
      this.logger.log(
        `Dropping stale campaign ${campaignId} job for contact ${index}, cursor is at ${campaign.dispatchedCount}`,
      );
      return;
    }

    // `max_concurrent`: the campaign's own ceiling, checked before the dial
    // because there is no undoing one.
    if (index !== undefined && (await this.liveCallCount(workspaceId, agentId)) >= maxConcurrent) {
      this.logger.warn(`Campaign ${campaignId} at max_concurrent ${maxConcurrent}, holding ${to}`);
      await this.defer(campaign, index, actorUserId, token, DEFER_MS);
      return;
    }

    try {
      await this.dial(job.data);
    } catch (err) {
      const deferral = index === undefined ? null : this.deferralReason(err);
      if (deferral !== null && index !== undefined) {
        this.logger.warn(`Campaign ${campaignId} holding ${to} (${deferral})`);
        await this.defer(
          campaign,
          index,
          actorUserId,
          token,
          deferral === 'outside_call_window' ? CALL_WINDOW_DEFER_MS : DEFER_MS,
        );
        return;
      }
      // A blocking billing denial paused the campaign. The dial for `index` never
      // happened, so the chain stops here: enqueueing the next contact would
      // restart dispatch, and advancing the cursor past `index` would make the
      // resume in `start()` skip that contact forever.
      if (await this.handleDispatchFailure(campaignId, workspaceId, to, err, index)) return;
    }

    if (index === undefined) return;

    // The next contact is enqueued only once this one is settled, spaced by
    // `max_calls_per_hour`. No next link means this was the last contact.
    const chained = await this.campaigns.dispatchContact(
      campaign,
      index + 1,
      actorUserId,
      Math.ceil(HOUR_MS / maxCallsPerHour),
      token,
    );
    if (!chained) await this.campaigns.markCompleted(campaignId, workspaceId);
    // Advanced last: until it moves, a retry of this job is still valid work.
    // Advancing first would make the retry look like a stale link and drop it.
    await this.campaigns.advanceCursor(campaignId, workspaceId, index + 1);
  }

  /**
   * Re-queues the same contact under a fresh token. A new token is required
   * because the job currently running still holds the id derived from the old
   * one, and BullMQ would discard the replacement as a duplicate.
   */
  private async defer(
    campaign: Parameters<OutboundCampaignService['dispatchContact']>[0],
    contactIndex: number,
    actorUserId: string,
    token: number,
    delayMs: number,
  ): Promise<void> {
    await this.campaigns.dispatchContact(
      campaign,
      contactIndex,
      actorUserId,
      delayMs,
      token + 1,
    );
  }

  /**
   * "Not now" rather than "not ever": the contact was never actually called, so
   * it is held and retried instead of being counted as a failed dial.
   *
   * Held by re-queueing rather than by rethrowing for BullMQ, because a
   * condition that outlives the retry budget would otherwise end the dispatch
   * chain and silently abandon every remaining contact.
   */
  private deferralReason(err: unknown): string | null {
    const admission = this.admissionReason(err);
    if (admission && RETRYABLE_ADMISSION_REASONS.has(admission)) return admission;

    if (!(err instanceof AppError) || err.errorCode !== 'COMPLIANCE_BLOCKED') return null;
    const reasons = (err.details as { reasons?: unknown } | undefined)?.reasons;
    if (!Array.isArray(reasons)) return null;
    const blocking = (reasons as Array<{ code?: unknown; severity?: unknown }>).filter(
      (reason) => reason?.severity === 'blocking',
    );
    // Only a closed call window is temporary. A DNC hit, an opt-out or a missing
    // consent record is permanent for this contact and must be recorded as a
    // failure, never retried into a second unwanted call.
    return blocking.length > 0 && blocking.every((r) => r.code === 'outside_call_window')
      ? 'outside_call_window'
      : null;
  }

  private async dial(data: OutboundCallJob): Promise<void> {
    const { campaignId, agentId, workspaceId, actorUserId, to, contactName, customData } = data;
    const metadata = {
      // Contact data first: everything below identifies the call to the campaign
      // and to compliance, and a contact's own `custom_data` must not be able to
      // move its call into another campaign or relabel why it was placed.
      ...customData,
      campaign_id: campaignId,
      ...(data.contactIndex === undefined ? {} : { contact_index: data.contactIndex }),
      purpose: data.purpose ?? 'requested_follow_up',
    };
    const assignedByoNumber = await this.findAssignedByoOutboundNumber(workspaceId, agentId);
    if (assignedByoNumber) {
      const call = await this.telephony.startOutboundCall(workspaceId, actorUserId, {
        phone_number_id: assignedByoNumber.id,
        to_number: to,
        contact_name: contactName,
        metadata,
      });

      this.logger.log(`Outbound campaign call queued via ${assignedByoNumber.provider}: ${call.call_id} to ${to}`);
      return;
    }

    const call = await this.calls.startOutboundCall(workspaceId, agentId, actorUserId, {
      to_number: to,
      contact_name: contactName,
      metadata,
    });

    this.logger.log(`Outbound campaign call queued: ${call.id} to ${to}`);
  }

  /**
   * Live outbound calls for the campaign's agent.
   *
   * `max_concurrent` is a campaign setting, but `calls` carries no campaign
   * column, so this counts per agent: a manual dial on the same agent is counted
   * too, which under-dials the campaign rather than over-dialling it — the safe
   * direction when the cost is money and a stranger's phone ringing. The
   * one-hour floor stops a leaked `queued` row from wedging a campaign forever.
   *
   * ponytail: counted per agent; add a `campaign_id` column to `calls` if two
   * campaigns on one agent ever need to pace independently.
   */
  private liveCallCount(workspaceId: string, agentId: string): Promise<number> {
    return this.prisma.call.count({
      where: {
        workspaceId,
        agentId,
        direction: 'outbound',
        status: { in: LIVE_CALL_STATUSES },
        createdAt: { gt: new Date(Date.now() - HOUR_MS) },
      },
    });
  }

  /**
   * A billing denial is not a dial failure. Distinguishing them keeps campaign
   * statistics honest and stops a drained balance from silently consuming an
   * entire contact list.
   *
   * Returns true when the campaign was paused, which the caller must treat as
   * "stop the chain": the contact was not dialled, so nothing after it may be
   * enqueued and the cursor may not move past it.
   */
  private async handleDispatchFailure(
    campaignId: string,
    workspaceId: string,
    to: string,
    err: unknown,
    contactIndex: number | undefined,
  ): Promise<boolean> {
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
      // No `failed` increment here: this contact was never dialled and the cursor
      // is deliberately left at its index, so resuming the campaign dispatches it
      // again. Counting it now would double-count it against the second attempt's
      // outcome, and inflate `failed` on every pause/resume cycle.
      await this.pauseCampaign(campaignId, workspaceId, reason);
      return true;
    }

    this.logger.error(`Outbound call failed for ${to}: ${message}`);
    // Counted only when the dial never became a call. A compliance block, an
    // unpublished agent or a plan gate throws before any row exists, so nothing
    // else would ever record it; every other failure already left a `failed`
    // call row, which the campaign's stats count directly.
    //
    // Matched on the contact's position, not its number: a list may hold the
    // same number twice, and matching on the number would let the first
    // contact's call row hide the second contact's failure.
    const dialled = await this.prisma.call.count({
      where: {
        workspaceId,
        AND: [
          { metadata: { path: ['campaign_id'], equals: campaignId } },
          contactIndex === undefined
            ? { toNumber: to }
            : { metadata: { path: ['contact_index'], equals: contactIndex } },
        ],
      },
    });
    // The key is the contact, so a retry of this job reports the same failure
    // rather than a second one.
    if (dialled === 0) {
      await this.campaigns.recordDispatchFailure(
        campaignId,
        contactIndex === undefined ? `to:${to}` : `contact:${contactIndex}`,
      );
    }
    return false;
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
