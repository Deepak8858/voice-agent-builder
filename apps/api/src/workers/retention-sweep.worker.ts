import { type Job } from 'bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { RetentionService } from '../compliance/retention.service';
import { env } from '../config/env';

export const RETENTION_SWEEP_QUEUE = 'retention-sweep';

/** The one scheduled job. There is no fan-out: the sweep is platform-wide. */
export const RETENTION_SWEEP_JOB = 'retention.sweep';

/** Stable key so re-registering on every boot updates rather than duplicates. */
export const RETENTION_SWEEP_SCHEDULER_KEY = 'retention-sweep';

/**
 * 03:30 UTC daily, as a constant rather than an env var: the cadence is a fixed
 * property of the design (one batch per day, see `processor`), not something an
 * operator tunes. `RETENTION_SWEEP_ENABLED` is the only knob this needs.
 */
const RETENTION_SWEEP_CRON = '30 3 * * *';

const SCHEDULER_REGISTRATION_ATTEMPTS = 5;
const SCHEDULER_RETRY_BASE_MS = 1_000;

export type RetentionSweepJob = Record<string, never>;

/**
 * Runs the retention sweep, which had no scheduler at all: every workspace
 * advertised a retention period and nothing ever enforced it.
 *
 * Shape mirrors {@link DigestWorker} — one repeatable job on a stable scheduler
 * key, registration retried in the background — minus the per-tenant fan-out.
 * A retention sweep is platform-wide by definition, and
 * `RetentionService.sweepExpiredCalls` already takes an optional scope, names it
 * in the audit row (`'all-workspaces'`) and bounds one run to a single batch, so
 * fanning out per workspace would multiply audit rows and Redis traffic without
 * bounding anything the service does not already bound.
 *
 * Gating is two flags, not one. `WORKERS_ENABLED` decides whether this module
 * loads at all; `RETENTION_SWEEP_ENABLED` decides whether the sweep is scheduled
 * and whether an already-scheduled run does anything. See the env.ts comment for
 * why this one destructive job gets its own switch.
 */
@Injectable()
export class RetentionSweepWorker
  extends BaseWorker<RetentionSweepJob>
  implements OnModuleInit
{
  constructor(
    private readonly queues: QueueService,
    private readonly retention: RetentionService,
  ) {
    // Concurrency 1: one bulk delete of up to 5000 calls at a time is the point.
    super(RETENTION_SWEEP_QUEUE, queues, 1);
  }

  onModuleInit(): void {
    if (!env.RETENTION_SWEEP_ENABLED) {
      // Warn, not debug: "nothing is enforcing retention" is a compliance state
      // an operator has to be able to see in the boot log.
      this.logger.warn(
        '[Retention] RETENTION_SWEEP_ENABLED is off — expired calls are NOT being deleted',
      );
      return;
    }
    // Registration retries in the background; a Redis outage must not hold the
    // Nest application bootstrap open for the full backoff window.
    void this.registerSchedule();
  }

  /** Idempotent by scheduler key, so replicas converge on one schedule. */
  async registerSchedule(): Promise<void> {
    const queue = this.queues.queue(RETENTION_SWEEP_QUEUE);

    for (let attempt = 1; attempt <= SCHEDULER_REGISTRATION_ATTEMPTS; attempt += 1) {
      try {
        await queue.upsertJobScheduler(
          RETENTION_SWEEP_SCHEDULER_KEY,
          // UTC pinned: expires_at is timestamptz and the sweep's cutoff is `now`,
          // so a schedule in a local zone would only move which wall-clock hour
          // the delete lands in, with no upside and a DST discontinuity.
          { pattern: RETENTION_SWEEP_CRON, tz: 'UTC' },
          { name: RETENTION_SWEEP_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
        );
        this.logger.log(
          `[Retention] Daily sweep scheduled (${RETENTION_SWEEP_CRON}, UTC)`,
        );
        return;
      } catch (err) {
        const message = (err as Error).message;
        if (attempt === SCHEDULER_REGISTRATION_ATTEMPTS) {
          // Loud on purpose: silence here means retention is advertised and never
          // enforced, which is the state this worker exists to end.
          this.logger.error(
            `[Retention] Failed to register the daily sweep after ${attempt} attempts — ` +
              `expired calls will NOT be deleted until the API restarts successfully: ${message}`,
          );
          return;
        }
        this.logger.warn(
          `[Retention] Schedule registration attempt ${attempt} failed (${message}) — retrying`,
        );
        await delay(SCHEDULER_RETRY_BASE_MS * attempt);
      }
    }
  }

  async processor(_job: Job<RetentionSweepJob>): Promise<void> {
    // Re-checked per run, not only at registration. BullMQ job schedulers live in
    // Redis, so the schedule outlives the process that created it: a deploy that
    // turns the flag off does not remove an already-registered scheduler, and the
    // job keeps arriving. This branch is what makes "off" actually mean off.
    if (!env.RETENTION_SWEEP_ENABLED) {
      this.logger.warn(
        '[Retention] Sweep job received while RETENTION_SWEEP_ENABLED is off — deleting nothing',
      );
      return;
    }

    // Scope-less on purpose: platform-wide is what a retention sweep is, and the
    // service stamps 'all-workspaces' into the audit row for exactly this call.
    const { deleted, remaining } = await this.retention.sweepExpiredCalls({});

    if (remaining > 0) {
      // ponytail: one 5000-call batch per day is the ceiling, so a backlog drains
      // over days rather than in one run — deliberate, because the alternative is
      // an unbounded irreversible delete loop holding locks on the calls table.
      // Upgrade path if a backlog ever needs to drain faster: re-enqueue this job
      // with a short delay while `remaining > 0`, bounded by a per-run job count.
      this.logger.warn(
        `[Retention] Swept ${deleted} expired call(s); ${remaining} still expired and ` +
          'will be picked up by the next daily run (one batch per run by design)',
      );
      return;
    }

    this.logger.log(`[Retention] Swept ${deleted} expired call(s); none remaining`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
