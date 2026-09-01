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
    await this.assertPhoneNumberAvailable(workspaceId, dto.agent_id, 'create');

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
