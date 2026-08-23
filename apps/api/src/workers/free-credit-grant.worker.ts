import { type Job } from 'bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CreditLedgerService, currentMonthKey } from '../billing/credit-ledger.service';
import { EntitlementService } from '../billing/entitlement.service';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { BaseWorker } from './base.worker';

export const FREE_CREDIT_GRANT_QUEUE = 'free-credit-grant';

/** Scheduled entry point: fans out one job per candidate organization. */
export const FREE_CREDIT_GRANT_SWEEP_JOB = 'billing.free_credit.sweep';
/** Per-organization grant, so one bad tenant cannot abort the whole sweep. */
export const FREE_CREDIT_GRANT_ORG_JOB = 'billing.free_credit.grant';

/** Stable key so re-registering on every boot updates rather than duplicates. */
export const FREE_CREDIT_GRANT_SCHEDULER_KEY = 'free-credit-grant';

const ORGANIZATION_PAGE_SIZE = 200;
const SCHEDULER_REGISTRATION_ATTEMPTS = 5;
const SCHEDULER_RETRY_BASE_MS = 1_000;

export interface FreeCreditGrantJob {
  /** Set on per-organization jobs; absent on the scheduled sweep job. */
  organizationId?: string;
  /**
   * The calendar month the grant belongs to, as `YYYY-MM`. Stamped by the
   * sweep rather than recomputed by the worker: a job that sits in the queue
   * across a month boundary must still grant the month it was enqueued for,
   * otherwise a retry would silently grant the wrong month.
   */
  monthKey?: string;
}

/**
 * Grants the free plan's recurring monthly minutes.
 *
 * Shape mirrors {@link DigestWorker}: a repeatable sweep fans out one job per
 * organization instead of looping inline, so a single tenant's failure retries
 * on its own without replaying grants for tenants already handled. The grant
 * itself is idempotent per organization per calendar month
 * (`CreditLedgerService.grantFreeMonthlyCredits`), so a duplicated job, an
 * overlapping replica, or a same-day re-run cannot hand out the allowance twice.
 *
 * Only organizations without paid access are granted. Paid organizations receive
 * their included minutes from Stripe invoice events; granting them here as well
 * would give them free minutes on top of what they bought.
 *
 * Gating: this lives in `WorkersModule`, which `app.module.ts` only imports when
 * `WORKERS_ENABLED` is true, so registration and consumption are governed by the
 * same flag and jobs cannot pile up with nothing to run them.
 */
@Injectable()
export class FreeCreditGrantWorker
  extends BaseWorker<FreeCreditGrantJob>
  implements OnModuleInit
{
  constructor(
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly creditLedger: CreditLedgerService,
    private readonly entitlements: EntitlementService,
  ) {
    super(FREE_CREDIT_GRANT_QUEUE, queues, 5);
  }

  onModuleInit(): void {
    // Registration retries in the background; a Redis outage must not hold the
    // Nest application bootstrap open for the full backoff window.
    void this.registerSchedule();
    // A deployment that spans the month boundary would otherwise leave every
    // free organization without minutes until the next scheduled run, so boot
    // also sweeps. Redundant with the cron by design: the grant is idempotent
    // per organization per month, so the extra pass grants nothing twice.
    void this.enqueueBootSweep();
  }

  /**
   * Enqueues one catch-up sweep for the current month.
   *
   * Failure is logged and swallowed: boot must not fail because Redis is
   * briefly unavailable, and the scheduled run remains the primary trigger.
   */
  async enqueueBootSweep(): Promise<void> {
    const monthKey = currentMonthKey();
    try {
      await this.queues.queue(FREE_CREDIT_GRANT_QUEUE).add(
        FREE_CREDIT_GRANT_SWEEP_JOB,
        { monthKey },
        {
          jobId: `${FREE_CREDIT_GRANT_SCHEDULER_KEY}:boot:${monthKey}`,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    } catch (err) {
      this.logger.warn(
        `[FreeCredit] Boot catch-up sweep for ${monthKey} could not be enqueued ` +
          `(${(err as Error).message}) — the scheduled run will cover it`,
      );
    }
  }

  /** Idempotent by scheduler key, so replicas converge on one schedule. */
  async registerSchedule(): Promise<void> {
    const queue = this.queues.queue(FREE_CREDIT_GRANT_QUEUE);

    for (let attempt = 1; attempt <= SCHEDULER_REGISTRATION_ATTEMPTS; attempt += 1) {
      try {
        await queue.upsertJobScheduler(
          FREE_CREDIT_GRANT_SCHEDULER_KEY,
          // UTC is pinned deliberately: the grant is keyed by UTC month, so a
          // schedule in another timezone would fire on a day that belongs to a
          // different month key than the operator expects.
          { pattern: env.FREE_CREDIT_GRANT_CRON, tz: 'UTC' },
          {
            name: FREE_CREDIT_GRANT_SWEEP_JOB,
            opts: { removeOnComplete: true, removeOnFail: 50 },
          },
        );
        this.logger.log(
          `[FreeCredit] Monthly free credit sweep scheduled (${env.FREE_CREDIT_GRANT_CRON}, UTC)`,
        );
        return;
      } catch (err) {
        const message = (err as Error).message;
        if (attempt === SCHEDULER_REGISTRATION_ATTEMPTS) {
          // Loud on purpose: without this schedule every free organization
          // silently loses its monthly minutes and cannot place a call.
          this.logger.error(
            `[FreeCredit] Failed to register the grant schedule after ${attempt} attempts — ` +
              `free plans will NOT receive monthly minutes until the API restarts successfully: ${message}`,
          );
          return;
        }
        this.logger.warn(
          `[FreeCredit] Schedule registration attempt ${attempt} failed (${message}) — retrying`,
        );
        await delay(SCHEDULER_RETRY_BASE_MS * attempt);
      }
    }
  }

  async processor(job: Job<FreeCreditGrantJob>): Promise<void> {
    if (job.name === FREE_CREDIT_GRANT_ORG_JOB) {
      const { organizationId, monthKey } = job.data;
      if (!organizationId) {
        throw new Error(`${FREE_CREDIT_GRANT_ORG_JOB} job is missing organizationId`);
      }
      if (!monthKey) {
        throw new Error(`${FREE_CREDIT_GRANT_ORG_JOB} job is missing monthKey`);
      }
      await this.grantOne(organizationId, monthKey);
      return;
    }

    await this.sweep(job.data.monthKey ?? currentMonthKey());
  }

  /**
   * Enqueue one grant job per active organization.
   *
   * Plan is re-checked per organization in {@link grantOne} rather than filtered
   * here. The subscription table only tells us which plan was *sold*; whether it
   * currently funds usage (status, expired trial) is `EntitlementService`'s
   * decision, and duplicating that logic in a query is how the two would drift.
   */
  private async sweep(monthKey: string): Promise<void> {
    const queue = this.queues.queue(FREE_CREDIT_GRANT_QUEUE);
    let cursor: string | undefined;
    let enqueued = 0;

    for (;;) {
      const organizations = await this.prisma.organization.findMany({
        where: { status: 'active' },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: ORGANIZATION_PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (organizations.length === 0) break;

      await queue.addBulk(
        organizations.map((organization) => ({
          name: FREE_CREDIT_GRANT_ORG_JOB,
          data: { organizationId: organization.id, monthKey },
          opts: {
            // Collapses duplicates if the sweep is replayed within the month.
            // The ledger is idempotent regardless; this just avoids the work.
            jobId: `${FREE_CREDIT_GRANT_SCHEDULER_KEY}:${organization.id}:${monthKey}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        })),
      );

      enqueued += organizations.length;
      cursor = organizations[organizations.length - 1]!.id;
      if (organizations.length < ORGANIZATION_PAGE_SIZE) break;
    }

    this.logger.log(
      `[FreeCredit] ${monthKey} sweep fanned out to ${enqueued} organization(s)`,
    );
  }

  private async grantOne(organizationId: string, monthKey: string): Promise<void> {
    const effective = await this.entitlements.getEffectivePlan(organizationId);
    if (effective.paidAccess) {
      this.logger.debug(
        `[FreeCredit] Organization ${organizationId} skipped: ${effective.plan} plan is funded by invoice grants`,
      );
      return;
    }
    // A corrupt subscription row resolves to `unknown` and must not be treated
    // as a free plan: granting there would hand credit to an organization whose
    // commercial state we cannot read. It is retried on the next sweep once the
    // row is corrected.
    if (effective.status === 'unknown') {
      this.logger.warn(
        `[FreeCredit] Organization ${organizationId} skipped: subscription state is unreadable`,
      );
      return;
    }
    if (effective.entitlements.includedMinutes <= 0) {
      this.logger.debug(
        `[FreeCredit] Organization ${organizationId} skipped: ${effective.plan} plan includes no monthly minutes`,
      );
      return;
    }

    const balance = await this.creditLedger.grantFreeMonthlyCredits({
      organizationId,
      monthKey,
    });
    this.logger.debug(
      `[FreeCredit] Organization ${organizationId} holds ${balance.availableSeconds}s available after the ${monthKey} grant`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
