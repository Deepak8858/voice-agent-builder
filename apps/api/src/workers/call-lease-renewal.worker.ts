import { type Job } from 'bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CallConcurrencyService } from '../billing/call-concurrency.service';
import { env } from '../config/env';
import { QueueService } from '../queue/queue.service';
import { BaseWorker } from './base.worker';

export const CALL_LEASE_RENEWAL_QUEUE = 'call-lease-renewal';
export const CALL_LEASE_RENEWAL_JOB = 'billing.leases.renew';
/** Stable key so a redeploy updates the schedule instead of stacking another. */
export const CALL_LEASE_RENEWAL_SCHEDULER_KEY = 'billing-renew-call-leases';

const SCHEDULER_REGISTRATION_ATTEMPTS = 5;
const SCHEDULER_RETRY_BASE_MS = 1_000;
const MIN_INTERVAL_SECONDS = 5;
/**
 * Sweeps run three times per TTL so a single missed run cannot expire a lease.
 * Deriving this from the TTL rather than a separate setting means the two can
 * never be configured into disagreement.
 */
const SWEEPS_PER_TTL = 3;

export function leaseRenewalIntervalMs(): number {
  const seconds = Math.max(
    Math.floor(env.BILLING_LEASE_TTL_SECONDS / SWEEPS_PER_TTL),
    MIN_INTERVAL_SECONDS,
  );
  return seconds * 1_000;
}

export interface CallLeaseRenewalJob {
  /** Optional per-run override; defaults to the configured batch size. */
  limit?: number;
}

/**
 * Keeps long calls inside their concurrency contract.
 *
 * A lease expires after `BILLING_LEASE_TTL_SECONDS`, which is capped at five
 * minutes. Nothing renewed it, so any call longer than the TTL lost its slot:
 * reconciliation released the lease while the call was still connected, and the
 * organization could then exceed the concurrency its plan sells. This sweep
 * extends the leases of calls that are still in flight.
 *
 * Concurrency is 1 so replicas do not fight over the same rows. The sweep is
 * idempotent — renewing an already-renewed lease just moves the expiry out
 * again — and fails closed: `renew()` releases the Redis member whenever the
 * durable record does not agree, so an inconsistent lease is dropped rather
 * than silently held.
 */
@Injectable()
export class CallLeaseRenewalWorker
  extends BaseWorker<CallLeaseRenewalJob>
  implements OnModuleInit
{
  constructor(
    private readonly queues: QueueService,
    private readonly concurrency: CallConcurrencyService,
  ) {
    super(CALL_LEASE_RENEWAL_QUEUE, queues, 1);
  }

  async onModuleInit(): Promise<void> {
    await this.registerSchedule();
  }

  async registerSchedule(): Promise<void> {
    const queue = this.queues.queue(CALL_LEASE_RENEWAL_QUEUE);
    const every = leaseRenewalIntervalMs();

    for (let attempt = 1; attempt <= SCHEDULER_REGISTRATION_ATTEMPTS; attempt += 1) {
      try {
        await queue.upsertJobScheduler(
          CALL_LEASE_RENEWAL_SCHEDULER_KEY,
          { every },
          { name: CALL_LEASE_RENEWAL_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
        );
        this.logger.log(
          `[CallLeaseRenewal] Renewal sweep scheduled every ${every / 1_000}s ` +
            `(lease TTL ${env.BILLING_LEASE_TTL_SECONDS}s)`,
        );
        return;
      } catch (err) {
        const message = (err as Error).message;
        if (attempt === SCHEDULER_REGISTRATION_ATTEMPTS) {
          // Loud on purpose: without this sweep, every call longer than the
          // lease TTL silently gives its concurrency slot back mid-call.
          this.logger.error(
            `[CallLeaseRenewal] Failed to register the renewal sweep after ${attempt} attempts — ` +
              `calls longer than ${env.BILLING_LEASE_TTL_SECONDS}s will lose their concurrency ` +
              `slot until the API restarts successfully: ${message}`,
          );
          return;
        }
        this.logger.warn(
          `[CallLeaseRenewal] Schedule registration attempt ${attempt} failed (${message}) — retrying`,
        );
        await delay(SCHEDULER_RETRY_BASE_MS * attempt);
      }
    }
  }

  async processor(job: Job<CallLeaseRenewalJob>): Promise<void> {
    if (job.name !== CALL_LEASE_RENEWAL_JOB) {
      throw new Error(`Unknown call lease renewal job: ${job.name}`);
    }

    const limit = job.data?.limit ?? env.BILLING_RECONCILIATION_BATCH_SIZE;
    const report = await this.concurrency.renewActiveLeases(limit);
    if (report.checked === 0) return;

    this.logger.debug(
      `[CallLeaseRenewal] renewed ${report.renewed}/${report.checked} lease(s)`,
    );
    if (report.dropped > 0) {
      this.logger.warn(
        `[CallLeaseRenewal] ${report.dropped} in-flight lease(s) could not be renewed and will expire`,
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
