import { Injectable, Logger } from '@nestjs/common';
import { OutboundCampaignScheduleSchema } from '@voiceforge/shared';
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

export const HOUR_MS = 60 * 60 * 1000;

/** Call statuses that mean the call has not finished yet. */
/**
 * Attempt keys of contacts that failed before any call row existed. One entry
 * per contact, so a retried job cannot count the same contact twice.
 */
function readDispatchFailures(stats: Record<string, unknown>): string[] {
  const raw = stats.dispatch_failures;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}

export const LIVE_CALL_STATUSES = ['queued', 'ringing', 'in_progress'];

/** Progress of a campaign, derived per read from its calls. */
export interface CampaignStats {
  total: number;
  completed: number;
  failed: number;
  in_progress: number;
  /** Contacts that never produced a call row (compliance, plan gate, agent). */
  dispatch_failed: number;
}

/** Mirrors the DTO defaults, for a persisted `schedule` that no longer parses. */
const DEFAULT_SCHEDULE = { max_calls_per_hour: 10, max_concurrent: 3 };

/**
 * A dispatch job may be re-run: the worker throws on a "not now" admission
 * denial specifically so the contact is dialled once capacity returns. Without
 * `attempts` BullMQ drops that throw on the floor and the contact is never
 * called.
 */
export const DISPATCH_ATTEMPTS = 5;

/**
 * Short enough that the first retry still falls inside the 60s outbound dedupe
 * window in CallsService, so a retry of a job that did dial is suppressed there
 * rather than dialling the same person twice.
 */
export const DISPATCH_BACKOFF_MS = 15_000;

/** Fields of a campaign row the dispatcher needs to enqueue one contact. */
export interface DispatchableCampaign {
  id: string;
  agentId: string;
  workspaceId: string;
  purpose: string;
  contacts: Prisma.JsonValue;
  schedule: Prisma.JsonValue;
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
    const campaigns = await this.prisma.outboundCampaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      // The card names the agent. Without this the list only carried `agentId`
      // and every campaign read "No agent".
      include: { agent: { select: { id: true, name: true } } },
    });
    // ponytail: one stats query per campaign; a workspace has a handful of
    // campaigns. Group in SQL if that ever stops being true.
    return Promise.all(
      campaigns.map(async (campaign) => ({
        ...campaign,
        stats: await this.computeStats(workspaceId, campaign.id, campaign.stats),
      })),
    );
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    dto: {
      agent_id: string;
      name: string;
      contacts: CampaignContact[];
      schedule?: Record<string, unknown>;
      purpose: string;
    },
  ) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: dto.agent_id, workspaceId },
      select: { id: true, status: true },
    });
    if (!agent) throw new AgentNotFoundError(dto.agent_id);
    this.assertAgentPublished(agent.status, 'creating');
    await this.assertPhoneNumberAvailable(workspaceId, dto.agent_id, 'create');

    const campaign = await this.prisma.outboundCampaign.create({
      data: {
        workspaceId,
        agentId: dto.agent_id,
        name: dto.name,
        purpose: dto.purpose,
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
        purpose: dto.purpose,
        contact_count: dto.contacts.length,
      },
    });
    return campaign;
  }

  /**
   * The compliance engine refuses non-published agents per dial; failing at
   * create/start gives the user the fix before any contact is enqueued.
   */
  private assertAgentPublished(status: string, stage: 'creating' | 'starting'): void {
    if (status === 'published') return;
    throw new AppError(
      'AGENT_NOT_PUBLISHED',
      `Publish the agent before ${stage} a campaign.`,
      409,
    );
  }

  // create asks "does a usable-intent number exist" (assignment/configure legitimately
  // happen after the wizard); start mirrors the worker's exact dial predicate
  // (findAssignedByoOutboundNumber) so a started campaign can never fail per-contact
  // with NO_PHONE_NUMBER; the legacy count keeps managed-Twilio workspaces working.
  private async assertPhoneNumberAvailable(
    workspaceId: string,
    agentId: string,
    stage: 'create' | 'start',
  ) {
    const [legacyCount, byoNumber] = await Promise.all([
      this.prisma.twilioPhoneNumber.count({ where: { workspaceId } }),
      this.prisma.telephonyPhoneNumber.findFirst({
        where:
          stage === 'create'
            ? {
                workspaceId,
                outboundEnabled: true,
                status: { notIn: ['pending_verification', 'disconnected'] },
              }
            : {
                workspaceId,
                assignedAgentId: agentId,
                outboundEnabled: true,
                status: { not: 'disconnected' },
                livekitConfig: { is: { outboundTrunkId: { not: null } } },
              },
        select: { id: true },
      }),
    ]);
    if (legacyCount > 0 || byoNumber) return;
    throw new AppError(
      'PHONE_NUMBER_REQUIRED',
      stage === 'create'
        ? 'Add an outbound-enabled phone number before creating a campaign.'
        : 'Assign a configured outbound phone number to this agent before starting the campaign.',
      409,
      { redirect: '/dashboard/settings/phone-numbers', stage },
    );
  }

  async start(workspaceId: string, campaignId: string, actorUserId: string) {
    const campaign = await this.prisma.outboundCampaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!campaign) throw new AppError('NOT_FOUND', 'Campaign not found', 404);
    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      throw new AppError('INVALID_STATUS', `Cannot start campaign in ${campaign.status} status`, 400);
    }

    const agent = await this.prisma.agent.findFirst({
      where: { id: campaign.agentId, workspaceId },
      select: { status: true },
    });
    this.assertAgentPublished(agent?.status ?? 'missing', 'starting');
    await this.assertPhoneNumberAvailable(workspaceId, campaign.agentId, 'start');

    const contacts = this.readContacts(campaign.contacts);
    // Resume, never replay: contacts the dispatcher already handed to the dialer
    // are skipped. Restarting a paused campaign used to re-enqueue the entire
    // list and call everyone a second time.
    const cursor = Math.min(campaign.dispatchedCount, contacts.length);
    const exhausted = cursor >= contacts.length;
    const stats = (campaign.stats ?? {}) as Record<string, unknown>;

    // Conditional on the status just read, so two concurrent starts cannot both
    // launch a dispatch chain over the same contacts.
    const claimed = await this.prisma.outboundCampaign.updateMany({
      where: { id: campaignId, workspaceId, status: campaign.status },
      data: {
        status: exhausted ? 'completed' : 'running',
        // Counters survive a pause; only the total is re-derived. Zeroing them
        // on resume would erase the failures already recorded for this list.
        stats: { ...stats, total: contacts.length } as Prisma.InputJsonValue,
      },
    });
    if (claimed.count === 0) {
      throw new AppError('INVALID_STATUS', 'Campaign status changed, retry the start.', 409);
    }

    // One contact is enqueued here; the worker chains the next after each dial.
    // That is what makes `max_calls_per_hour` enforceable and a pause immediate.
    if (!exhausted) {
      await this.dispatchContact(campaign, cursor, actorUserId, 0, Date.now());
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
        resumed_from: cursor,
      },
    });

    this.logger.log(
      `Campaign ${campaignId} ${cursor > 0 ? `resumed at contact ${cursor} of` : 'started with'} ${contacts.length} contacts`,
    );
  }

  /**
   * Enqueues exactly one contact, or returns false when `contactIndex` is past
   * the end of the list.
   *
   * `dispatchToken` discriminates one run of the chain from another. The job id
   * is deterministic within a run, so a redelivered dispatcher job re-adding the
   * same chain link is a no-op instead of a second dial; a resumed campaign
   * carries a fresh token so its links are not swallowed as duplicates of the
   * previous run's.
   */
  async dispatchContact(
    campaign: DispatchableCampaign,
    contactIndex: number,
    actorUserId: string,
    delayMs: number,
    dispatchToken: number,
  ): Promise<boolean> {
    const contact = this.readContacts(campaign.contacts)[contactIndex];
    if (!contact) return false;

    await this.queue.enqueue(
      OUTBOUND_CAMPAIGN_QUEUE,
      'call',
      {
        campaignId: campaign.id,
        agentId: campaign.agentId,
        workspaceId: campaign.workspaceId,
        purpose: campaign.purpose,
        actorUserId,
        to: contact.phone,
        contactName: contact.full_name,
        customData: contact.custom_data,
        contactIndex,
        dispatchToken,
      },
      {
        delay: delayMs,
        attempts: DISPATCH_ATTEMPTS,
        backoff: { type: 'exponential', delay: DISPATCH_BACKOFF_MS },
        jobId: `${campaign.id}:${contactIndex}:${dispatchToken}`,
      },
    );
    return true;
  }

  /**
   * Monotonic resume pointer. Deliberately not a per-contact claim: a job that
   * was retried because the dial never happened must still be allowed to dial,
   * and double-dial protection lives in CallsService's dedupe window.
   */
  async advanceCursor(
    campaignId: string,
    workspaceId: string,
    dispatchedCount: number,
  ): Promise<void> {
    await this.prisma.outboundCampaign.updateMany({
      where: { id: campaignId, workspaceId, dispatchedCount: { lt: dispatchedCount } },
      data: { dispatchedCount },
    });
  }

  /** Scoped to `running` so it cannot overwrite a campaign paused mid-chain. */
  async markCompleted(campaignId: string, workspaceId: string): Promise<void> {
    await this.prisma.outboundCampaign.updateMany({
      where: { id: campaignId, workspaceId, status: 'running' },
      data: { status: 'completed' },
    });
  }

  /** Pacing limits for a campaign, falling back to the DTO defaults. */
  readSchedule(schedule: Prisma.JsonValue): { maxCallsPerHour: number; maxConcurrent: number } {
    const parsed = OutboundCampaignScheduleSchema.safeParse(schedule);
    const value = parsed.success ? parsed.data : DEFAULT_SCHEDULE;
    return {
      maxCallsPerHour: value.max_calls_per_hour,
      maxConcurrent: value.max_concurrent,
    };
  }

  private readContacts(contacts: Prisma.JsonValue): CampaignContact[] {
    return Array.isArray(contacts) ? (contacts as unknown as CampaignContact[]) : [];
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
      select: { id: true, stats: true },
    });
    if (!campaign) return undefined;
    return this.computeStats(workspaceId, campaign.id, campaign.stats);
  }

  async getCampaign(workspaceId: string, campaignId: string) {
    const campaign = await this.prisma.outboundCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      include: { agent: { select: { id: true, name: true } } },
    });
    if (!campaign) return null;
    return { ...campaign, stats: await this.computeStats(workspaceId, campaign.id, campaign.stats) };
  }

  /**
   * Campaign progress counted from the calls the campaign placed, not from
   * counters kept by hand.
   *
   * The worker used to increment `in_progress` on dial and nothing ever
   * decremented it, because a call is finalized by a webhook, a runtime report
   * or a manual end — several writers, none of which knew about campaigns. Every
   * campaign therefore showed its whole contact list as permanently in progress.
   * Counting the rows instead cannot drift, whichever path ends the call.
   *
   * `dispatch_failed` is the one number that still has to be persisted: a
   * contact blocked by compliance, an unpublished agent or a plan gate never
   * produces a call row to count.
   */
  async computeStats(
    workspaceId: string,
    campaignId: string,
    persisted: Prisma.JsonValue,
  ): Promise<CampaignStats> {
    const stats = (persisted ?? {}) as Record<string, unknown>;
    const total = typeof stats.total === 'number' ? stats.total : 0;
    const dispatchFailed = readDispatchFailures(stats).length;

    // ponytail: campaign_id lives in the call's metadata JSON, so this is an
    // unindexed path filter behind the workspace index. Add a `campaign_id`
    // column if campaigns ever grow past a few thousand calls.
    const grouped = await this.prisma.call.groupBy({
      by: ['status'],
      where: {
        workspaceId,
        metadata: { path: ['campaign_id'], equals: campaignId },
      },
      _count: { _all: true },
    });
    const count = (statuses: string[]) =>
      grouped
        .filter((row) => statuses.includes(row.status))
        .reduce((sum, row) => sum + row._count._all, 0);

    return {
      total,
      completed: count(['completed']),
      failed: count(['failed', 'cancelled']) + dispatchFailed,
      in_progress: count(LIVE_CALL_STATUSES),
      dispatch_failed: dispatchFailed,
    };
  }

  /**
   * Records a contact that never became a call. Anything that did produce a call
   * row is counted from that row by `computeStats`, so counting it here too
   * would count the same failure twice.
   *
   * The failures are held as a set of attempt keys rather than a counter,
   * because the job that reports one can be retried: BullMQ re-runs the whole
   * job when a later step throws, and a counter would climb once per retry.
   *
   * ponytail: read-modify-write on the campaign's `stats` JSON. Safe because one
   * campaign dispatches one contact at a time; needs a row lock (or its own
   * table) if dispatch ever fans out within a campaign.
   */
  async recordDispatchFailure(campaignId: string, attemptKey: string): Promise<void> {
    const campaign = await this.prisma.outboundCampaign.findUnique({
      where: { id: campaignId },
      select: { stats: true },
    });
    if (!campaign) return;
    const stats = (campaign.stats ?? {}) as Record<string, unknown>;
    const failures = readDispatchFailures(stats);
    if (failures.includes(attemptKey)) return;
    await this.prisma.outboundCampaign.update({
      where: { id: campaignId },
      data: {
        stats: { ...stats, dispatch_failures: [...failures, attemptKey] } as Prisma.InputJsonValue,
      },
    });
  }
}
