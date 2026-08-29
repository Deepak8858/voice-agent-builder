import { type Job } from 'bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ReconciliationService } from '../billing/reconciliation.service';
import { env } from '../config/env';
import { QueueService } from '../queue/queue.service';
import { BaseWorker } from './base.worker';

export const BILLING_RECONCILIATION_QUEUE = 'billing-reconciliation';

/**
 * Named jobs, each mapping to exactly one bounded reconciliation method so a
 * failure in one repair cannot prevent the others from running.
 */
export const BILLING_RECONCILIATION_JOBS = {
  balances: 'billing.reconcile.balances',
  buckets: 'billing.reconcile.buckets',
  staleCalls: 'billing.reconcile.stale_calls',
  leases: 'billing.reconcile.leases',
  costs: 'billing.reconcile.costs',
  margins: 'billing.reconcile.margins',
  stripeDrift: 'billing.reconcile.stripe_drift',
} as const;

export type BillingReconciliationJobName =
  (typeof BILLING_RECONCILIATION_JOBS)[keyof typeof BILLING_RECONCILIATION_JOBS];

/** Stable scheduler keys so a redeploy updates schedules instead of duplicating them. */
const SCHEDULER_KEYS: Record<BillingReconciliationJobName, string> = {
  [BILLING_RECONCILIATION_JOBS.balances]: 'billing-reconcile-balances',
  [BILLING_RECONCILIATION_JOBS.buckets]: 'billing-reconcile-buckets',
  [BILLING_RECONCILIATION_JOBS.staleCalls]: 'billing-reconcile-stale-calls',
  [BILLING_RECONCILIATION_JOBS.leases]: 'billing-reconcile-leases',
  [BILLING_RECONCILIATION_JOBS.costs]: 'billing-reconcile-costs',
  [BILLING_RECONCILIATION_JOBS.margins]: 'billing-reconcile-margins',
  [BILLING_RECONCILIATION_JOBS.stripeDrift]: 'billing-reconcile-stripe-drift',
};

const SCHEDULER_REGISTRATION_ATTEMPTS = 5;
const SCHEDULER_RETRY_BASE_MS = 1_000;

export interface BillingReconciliationJob {
  /** Optional per-run override; defaults to the configured batch size. */
  limit?: number;
}

/**
 * Runs the billing repairs on a schedule.
 *
 * Concurrency is 1: these repairs already take per-organization advisory locks,
 * and running several batches at once against the same rows would produce lock
 * contention with no throughput gain.
 *
 * Like every other worker here, this only starts when `WORKERS_ENABLED` is true:
 * `app.module.ts` only imports `WorkersModule` under that flag, so a replica
 * with workers disabled never constructs this class and therefore never
 * registers a schedule. Registration and consumption are gated by the same
 * condition, so jobs cannot accumulate with nothing to run them.
 */
@Injectable()
export class BillingReconciliationWorker
  extends BaseWorker<BillingReconciliationJob>
  implements OnModuleInit
{
  constructor(
    private readonly queues: QueueService,
    private readonly reconciliation: ReconciliationService,
  ) {
    super(BILLING_RECONCILIATION_QUEUE, queues, 1);
  }

  onModuleInit(): void {
    // Registration retries in the background; a Redis outage must not hold the
    // Nest application bootstrap open for the full backoff window.
    void this.registerSchedules();
  }

  /** Idempotent by scheduler key, so replicas converge on one schedule each. */
  async registerSchedules(): Promise<void> {
    const queue = this.queues.queue(BILLING_RECONCILIATION_QUEUE);

    for (const [jobName, schedulerKey] of Object.entries(SCHEDULER_KEYS)) {
      for (let attempt = 1; attempt <= SCHEDULER_REGISTRATION_ATTEMPTS; attempt += 1) {
        try {
          await queue.upsertJobScheduler(
            schedulerKey,
            { pattern: env.BILLING_RECONCILIATION_CRON },
            { name: jobName, opts: { removeOnComplete: true, removeOnFail: 50 } },
          );
          break;
        } catch (err) {
          const message = (err as Error).message;
          if (attempt === SCHEDULER_REGISTRATION_ATTEMPTS) {
            // Loud on purpose: without this schedule, balance drift and leaked
            // reservations accumulate silently until a customer complains.
            this.logger.error(
              `[BillingReconciliation] Failed to register ${schedulerKey} after ${attempt} attempts — ` +
                `this repair will NOT run until the API restarts successfully: ${message}`,
            );
            break;
          }
          this.logger.warn(
            `[BillingReconciliation] Schedule registration attempt ${attempt} for ${schedulerKey} ` +
              `failed (${message}) — retrying`,
          );
          await delay(SCHEDULER_RETRY_BASE_MS * attempt);
        }
      }
    }

    this.logger.log(
      `[BillingReconciliation] Repairs scheduled (${env.BILLING_RECONCILIATION_CRON}, ` +
        `batch size ${env.BILLING_RECONCILIATION_BATCH_SIZE})`,
    );
  }

  async processor(job: Job<BillingReconciliationJob>): Promise<void> {
    const limit = job.data?.limit;

    switch (job.name) {
      case BILLING_RECONCILIATION_JOBS.balances: {
        const report = await this.reconciliation.reconcileBalances(limit);
        this.log('balances', report.projectionCorrections, report.organizationsChecked);
        return;
      }
      case BILLING_RECONCILIATION_JOBS.buckets: {
        const report = await this.reconciliation.expireBuckets(limit);
        this.log('buckets', report.expiredBuckets);
        return;
      }
      case BILLING_RECONCILIATION_JOBS.staleCalls: {
        const report = await this.reconciliation.finalizeStaleCalls(limit);
        this.log('stale calls', report.staleCallsFinalized);
        if (report.manualReviewsCreated > 0) {
          this.logger.warn(
            `[BillingReconciliation] ${report.manualReviewsCreated} organization(s) flagged for manual review`,
          );
        }
        return;
      }
      case BILLING_RECONCILIATION_JOBS.leases: {
        const report = await this.reconciliation.recoverLeases(limit);
        this.log('leases', report.leasesRecovered);
        return;
      }
      case BILLING_RECONCILIATION_JOBS.costs: {
        const report = await this.reconciliation.reconcileProviderCosts(limit);
        this.log('provider costs', report.costEventsEstimated);
        return;
      }
      case BILLING_RECONCILIATION_JOBS.margins: {
        await this.reconciliation.publishMarginMetrics();
        return;
      }
      case BILLING_RECONCILIATION_JOBS.stripeDrift: {
        const report = await this.reconciliation.reportStripeDrift(limit);
        const drift =
          report.stripePaidInvoicesWithoutCredit +
          report.stripePaidPacksWithoutCredit +
          report.stripeSubscriptionDrift;
        if (drift === 0) {
          this.log('stripe drift', 0, report.stripeObjectsCompared);
          return;
        }
        // Warn, not log: nothing was repaired, so this needs a human to look.
        this.logger.warn(
          `[BillingReconciliation] Stripe drift across ${report.stripeObjectsCompared} Stripe ` +
            `object(s): ${report.stripePaidInvoicesWithoutCredit} paid invoice(s) with no credit, ` +
            `${report.stripePaidPacksWithoutCredit} paid pack(s) with no credit, ` +
            `${report.stripeSubscriptionDrift} subscription mismatch(es) — reported only, nothing repaired`,
        );
        return;
      }
      default:
        throw new Error(`Unknown billing reconciliation job: ${job.name}`);
    }
  }

  private log(label: string, corrections: number, checked?: number): void {
    if (corrections === 0) {
      this.logger.debug(`[BillingReconciliation] ${label}: no corrections needed`);
      return;
    }
    const scope = checked === undefined ? '' : ` across ${checked} organization(s)`;
    this.logger.log(`[BillingReconciliation] ${label}: ${corrections} correction(s)${scope}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
