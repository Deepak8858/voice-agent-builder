import { type Job } from 'bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { env } from '../config/env';

export const DIGEST_QUEUE = 'digest';

/** Scheduled entry point: fans out one job per active workspace. */
export const DIGEST_FANOUT_JOB = 'digest.fanout';
/** Per-workspace delivery, so one bad tenant cannot abort the whole run. */
export const DIGEST_WORKSPACE_JOB = 'digest.workspace';

/** Stable key so re-registering on every boot updates rather than duplicates. */
export const DIGEST_SCHEDULER_KEY = 'weekly-digest';

const WORKSPACE_PAGE_SIZE = 200;
const SCHEDULER_REGISTRATION_ATTEMPTS = 5;
const SCHEDULER_RETRY_BASE_MS = 1_000;

export interface DigestJob {
  /** Set on per-workspace jobs; absent on the scheduled fan-out job. */
  workspaceId?: string;
}

/**
 * Delivers the weekly digest.
 *
 * `EmailService.sendWeeklyDigest` existed, was fully tested, and had no caller:
 * no scheduler, no cron, no queue registration. The feature was unreachable in
 * production and the test suite could not detect that, because every test
 * invoked the method directly. This worker is the missing trigger.
 *
 * Shape: a repeatable job fans out one job per workspace rather than looping
 * inline. Per-workspace jobs retry and fail independently, so a single tenant's
 * failure neither aborts the run nor replays delivery for tenants already sent.
 *
 * Gating: this lives in `WorkersModule`, which `app.module.ts` only imports when
 * `WORKERS_ENABLED` is true. No second feature flag is added deliberately —
 * another default-off switch is how this feature came to be dormant.
 */
@Injectable()
export class DigestWorker extends BaseWorker<DigestJob> implements OnModuleInit {
  constructor(
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {
    super(DIGEST_QUEUE, queues, 5);
  }

  async onModuleInit(): Promise<void> {
    await this.registerSchedule();
  }

  /**
   * Idempotent by scheduler key, so concurrent API replicas converge on one
   * schedule instead of multiplying deliveries.
   */
  async registerSchedule(): Promise<void> {
    const queue = this.queues.queue(DIGEST_QUEUE);

    for (let attempt = 1; attempt <= SCHEDULER_REGISTRATION_ATTEMPTS; attempt += 1) {
      try {
        await queue.upsertJobScheduler(
          DIGEST_SCHEDULER_KEY,
          { pattern: env.WEEKLY_DIGEST_CRON, tz: env.WEEKLY_DIGEST_TIMEZONE },
          { name: DIGEST_FANOUT_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
        );
        this.logger.log(
          `[Digest] Weekly digest scheduled (${env.WEEKLY_DIGEST_CRON}, ${env.WEEKLY_DIGEST_TIMEZONE})`,
        );
        return;
      } catch (err) {
        const message = (err as Error).message;
        if (attempt === SCHEDULER_REGISTRATION_ATTEMPTS) {
          // Loud on purpose: silence here means the digest silently stops shipping.
          this.logger.error(
            `[Digest] Failed to register the weekly schedule after ${attempt} attempts — ` +
            `the digest will NOT be sent until the API restarts successfully: ${message}`,
          );
          return;
        }
        this.logger.warn(
          `[Digest] Schedule registration attempt ${attempt} failed (${message}) — retrying`,
        );
        await delay(SCHEDULER_RETRY_BASE_MS * attempt);
      }
    }
  }

  async processor(job: Job<DigestJob>): Promise<void> {
    if (job.name === DIGEST_WORKSPACE_JOB) {
      const { workspaceId } = job.data;
      if (!workspaceId) throw new Error('digest.workspace job is missing workspaceId');
      const result = await this.email.sendWeeklyDigest(workspaceId);
      if (result.status === 'skipped') {
        this.logger.debug(`[Digest] Workspace ${workspaceId} skipped: ${result.reason}`);
      }
      return;
    }

    await this.fanOut();
  }

  /**
   * Enqueue one delivery job per active workspace.
   *
   * Paginated by cursor: the workspace table is tenant-scale, and loading it in
   * one query would put an unbounded result set in memory on a weekly timer.
   */
  private async fanOut(): Promise<void> {
    if (!env.RESEND_API_KEY) {
      // Avoid enqueuing thousands of jobs that would each individually skip.
      this.logger.warn('[Digest] RESEND_API_KEY not set — skipping the weekly run entirely');
      return;
    }

    const queue = this.queues.queue(DIGEST_QUEUE);
    let cursor: string | undefined;
    let enqueued = 0;

    for (;;) {
      const workspaces = await this.prisma.workspace.findMany({
        where: { status: 'active' },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: WORKSPACE_PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (workspaces.length === 0) break;

      await queue.addBulk(
        workspaces.map((workspace) => ({
          name: DIGEST_WORKSPACE_JOB,
          data: { workspaceId: workspace.id },
          opts: {
            // Collapses duplicates if a fan-out is somehow replayed in the same week.
            jobId: `${DIGEST_SCHEDULER_KEY}:${workspace.id}:${currentWeekKey()}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        })),
      );

      enqueued += workspaces.length;
      cursor = workspaces[workspaces.length - 1]!.id;
      if (workspaces.length < WORKSPACE_PAGE_SIZE) break;
    }

    this.logger.log(`[Digest] Weekly run fanned out to ${enqueued} workspace(s)`);
  }
}

/** ISO-ish year+week stamp used to make per-week job ids collision-free. */
export function currentWeekKey(now: Date = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Shift to the Thursday of this week; ISO weeks are defined by their Thursday.
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
