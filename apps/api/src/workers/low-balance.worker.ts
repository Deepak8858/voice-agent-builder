import { type Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { currentMonthKey, freeMonthlyGrantKey } from '../billing/credit-ledger.service';
import { EntitlementService } from '../billing/entitlement.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { BaseWorker } from './base.worker';

export const LOW_BALANCE_QUEUE = 'low-balance';
export const LOW_BALANCE_CHECK_JOB = 'low-balance.check';

/** Fraction of the monthly free allowance at or below which the warning sends. */
export const LOW_BALANCE_FRACTION = 0.2;

export interface LowBalanceJob {
  organizationId: string;
}

/**
 * Sends the low-balance warning email for FREE-plan organizations.
 *
 * No scheduler: this queue is fed by `RuntimeUsageService`, which enqueues
 * whenever an allowed metering decision reports the balance at or below the
 * threshold. The hot path's month-keyed `jobId` is the once-per-month
 * guarantee; this worker's job is the authoritative re-check, because the hot
 * path enqueues on whatever balance it happened to see (paid organizations
 * included) and must never block metering on plan or bucket lookups.
 */
@Injectable()
export class LowBalanceWorker extends BaseWorker<LowBalanceJob> {
  constructor(
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly email: EmailService,
  ) {
    super(LOW_BALANCE_QUEUE, queues, 5);
  }

  async processor(job: Job<LowBalanceJob>): Promise<void> {
    const { organizationId } = job.data;
    if (!organizationId) {
      throw new Error(`${LOW_BALANCE_CHECK_JOB} job is missing organizationId`);
    }

    const effective = await this.entitlements.getEffectivePlan(organizationId);
    if (effective.paidAccess) {
      this.logger.debug(
        `[LowBalance] Organization ${organizationId} skipped: ${effective.plan} plan is paid`,
      );
      return;
    }
    if (effective.status === 'unknown') {
      this.logger.debug(
        `[LowBalance] Organization ${organizationId} skipped: subscription state is unreadable`,
      );
      return;
    }

    // Warn on the current state of this month's free grant, not the balance the
    // hot path saw: a top-up between enqueue and here must suppress the email.
    const bucket = await this.prisma.billingCreditBucket.findUnique({
      where: {
        organizationId_sourceType_sourceId: {
          organizationId,
          sourceType: 'included',
          sourceId: freeMonthlyGrantKey(organizationId, currentMonthKey()),
        },
      },
      select: { originalSeconds: true, remainingSeconds: true },
    });
    if (!bucket || bucket.remainingSeconds > bucket.originalSeconds * LOW_BALANCE_FRACTION) {
      this.logger.debug(
        `[LowBalance] Organization ${organizationId} skipped: balance is above the threshold`,
      );
      return;
    }

    // Purchased packs survive a downgrade, so the spendable total can exceed
    // this month's grant; warn only when the whole balance is at the threshold.
    const balance = await this.prisma.organizationCreditBalance.findUnique({
      where: { organizationId },
      select: { availableSeconds: true },
    });
    if ((balance?.availableSeconds ?? 0) > bucket.originalSeconds * LOW_BALANCE_FRACTION) {
      this.logger.debug(
        `[LowBalance] Organization ${organizationId} skipped: total available balance is above the threshold`,
      );
      return;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, owner: { select: { email: true } } },
    });
    const to = organization?.owner?.email?.trim();
    if (!organization || !to) {
      this.logger.warn(
        `[LowBalance] Organization ${organizationId} skipped: owner has no email address`,
      );
      return;
    }

    // A delivery failure propagates so the job's own retries cover it; the
    // month-keyed jobId still caps the organization at one email per month.
    await this.email.sendLowBalanceWarning({
      to,
      organizationName: organization.name,
      remainingMinutes: Math.floor(bucket.remainingSeconds / 60),
      includedMinutes: bucket.originalSeconds / 60,
    });
    this.logger.log(`[LowBalance] Warning sent for organization ${organizationId}`);
  }
}
