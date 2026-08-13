import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PlanType } from '@voiceforge/shared';
import { getPlanById } from '@voiceforge/shared';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../common/metrics.service';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderCostService } from './provider-cost.service';

/**
 * Billing reconciliation.
 *
 * The credit ledger is the source of truth; `organization_credit_balances` is a
 * projection of it. Projections drift when a process dies between writes, and a
 * drifted projection either sells credit twice or refuses credit the customer
 * owns. Every method here is a bounded, idempotent repair that can be run
 * repeatedly without changing the outcome.
 *
 * Rules that hold across all repairs:
 * - a correction is always accompanied by an audit record;
 * - ambiguous state is flagged for review, never guessed at;
 * - provider costs are never mixed into the customer ledger.
 */

export interface BillingReconciliationReport {
  organizationsChecked: number;
  projectionCorrections: number;
  expiredBuckets: number;
  staleCallsFinalized: number;
  leasesRecovered: number;
  costEventsEstimated: number;
  manualReviewsCreated: number;
}

export function emptyReconciliationReport(): BillingReconciliationReport {
  return {
    organizationsChecked: 0,
    projectionCorrections: 0,
    expiredBuckets: 0,
    staleCallsFinalized: 0,
    leasesRecovered: 0,
    costEventsEstimated: 0,
    manualReviewsCreated: 0,
  };
}

/** Namespace for the advisory locks this service takes, so it cannot collide. */
const ADVISORY_LOCK_NAMESPACE = 947_231;

const MINUTE_MS = 60_000;

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly providerCosts: ProviderCostService,
  ) {}

  private get batchSize(): number {
    return env.BILLING_RECONCILIATION_BATCH_SIZE;
  }

  /**
   * Recompute the available/reserved projection from the buckets and repair
   * drift with a compensating, audited entry.
   */
  async reconcileBalances(limit = this.batchSize): Promise<BillingReconciliationReport> {
    const report = emptyReconciliationReport();
    const balances = await this.prisma.organizationCreditBalance.findMany({
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: {
        organizationId: true,
        availableSeconds: true,
        reservedSeconds: true,
      },
    });

    for (const balance of balances) {
      report.organizationsChecked += 1;
      try {
        const corrected = await this.reconcileOneBalance(balance.organizationId);
        if (corrected) report.projectionCorrections += 1;
      } catch (err) {
        this.logger.error(
          `Balance reconciliation failed for organization ${balance.organizationId}: ${(err as Error).message}`,
        );
      }
    }

    await this.publishBalanceGauges();
    this.countCorrections('projection', report.projectionCorrections);
    return report;
  }

  private async reconcileOneBalance(organizationId: string): Promise<boolean> {
    const correction = await this.withOrganizationLock(organizationId, async (tx) => {
      const now = new Date();
      const buckets = await tx.billingCreditBucket.findMany({
        where: {
          organizationId,
          status: 'active',
          validFrom: { lte: now },
          expiresAt: { gt: now },
        },
        select: { remainingSeconds: true },
      });
      const bucketSeconds = buckets.reduce((total, bucket) => total + bucket.remainingSeconds, 0);

      const balance = await tx.organizationCreditBalance.findUnique({
        where: { organizationId },
        select: { availableSeconds: true, reservedSeconds: true },
      });
      if (!balance) return null;

      // Reserved seconds are owned by in-flight calls, so they are subtracted
      // from the bucket-derived total rather than folded into it.
      const expectedAvailable = Math.max(bucketSeconds - balance.reservedSeconds, 0);
      const driftSeconds = expectedAvailable - balance.availableSeconds;
      if (driftSeconds === 0) return null;

      await tx.organizationCreditBalance.update({
        where: { organizationId },
        data: { availableSeconds: expectedAvailable, version: { increment: 1 } },
      });

      return {
        previousAvailableSeconds: balance.availableSeconds,
        correctedAvailableSeconds: expectedAvailable,
        reservedSeconds: balance.reservedSeconds,
        driftSeconds,
      };
    });

    if (!correction) return false;

    // Audited outside the lock so a slow audit write cannot hold the row.
    await this.audit.log({
      organizationId,
      action: 'billing.projection_corrected',
      resourceType: 'organization_credit_balance',
      resourceId: organizationId,
      metadata: correction,
    });
    return true;
  }

  /**
   * Retire buckets past their expiry.
   *
   * Status is flipped and remaining seconds are zeroed in one update so the
   * decrement can only be observed once, no matter how often this runs.
   */
  async expireBuckets(limit = this.batchSize): Promise<BillingReconciliationReport> {
    const report = emptyReconciliationReport();
    const now = new Date();
    const expired = await this.prisma.billingCreditBucket.findMany({
      where: { status: 'active', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: {
        id: true,
        organizationId: true,
        remainingSeconds: true,
        sourceType: true,
        expiresAt: true,
      },
    });

    for (const bucket of expired) {
      const changed = await this.prisma.billingCreditBucket.updateMany({
        where: { id: bucket.id, status: 'active' },
        data: { remainingSeconds: 0, status: 'expired' },
      });
      // Another replica won the race; it also owns the audit record.
      if (changed.count === 0) continue;

      report.expiredBuckets += 1;
      await this.audit.log({
        organizationId: bucket.organizationId,
        action: 'billing.bucket_expired',
        resourceType: 'billing_credit_bucket',
        resourceId: bucket.id,
        metadata: {
          sourceType: bucket.sourceType,
          forfeitedSeconds: bucket.remainingSeconds,
          expiresAt: bucket.expiresAt.toISOString(),
        },
      });
    }

    if (report.expiredBuckets > 0) {
      // Expiry changes the bucket-derived total, so refresh the projection.
      const organizationIds = [...new Set(expired.map((bucket) => bucket.organizationId))];
      for (const organizationId of organizationIds) {
        await this.reconcileOneBalance(organizationId).catch((err: Error) =>
          this.logger.error(
            `Post-expiry balance refresh failed for ${organizationId}: ${err.message}`,
          ),
        );
      }
    }

    this.countCorrections('bucket_expiry', report.expiredBuckets);
    return report;
  }

  /**
   * Finalize calls that were dispatched but never reported a connection.
   *
   * Without this, a runtime crash between dispatch and `call_connected` holds
   * the caller's reserved seconds forever and permanently reduces their usable
   * balance.
   */
  async finalizeStaleCalls(limit = this.batchSize): Promise<BillingReconciliationReport> {
    const report = emptyReconciliationReport();
    const cutoff = new Date(Date.now() - env.BILLING_STALE_CALL_TIMEOUT_MINUTES * MINUTE_MS);

    const stale = await this.prisma.callUsage.findMany({
      where: {
        finalizationState: 'pending',
        connectedAt: null,
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        organizationId: true,
        callId: true,
        reservedSeconds: true,
        debitedSeconds: true,
        createdAt: true,
      },
    });

    for (const usage of stale) {
      // A call with debited seconds did connect and something else went wrong.
      // Guessing at its duration would corrupt the customer's balance, so it is
      // routed to review instead.
      if (usage.debitedSeconds > 0) {
        const flagged = await this.flagForReview(
          usage.organizationId,
          usage.callId,
          'stale_call_with_debits',
        );
        if (flagged) report.manualReviewsCreated += 1;
        continue;
      }

      const changed = await this.prisma.callUsage.updateMany({
        where: { id: usage.id, finalizationState: 'pending' },
        data: {
          finalizationState: 'finalized',
          disposition: 'not_connected',
          endedAt: new Date(),
          reservedSeconds: 0,
          billableSeconds: 0,
        },
      });
      if (changed.count === 0) continue;

      report.staleCallsFinalized += 1;
      await this.releaseReservation(usage.organizationId, usage.reservedSeconds);
      await this.audit.log({
        organizationId: usage.organizationId,
        action: 'billing.stale_call_finalized',
        resourceType: 'call_usage',
        resourceId: usage.callId,
        metadata: {
          releasedSeconds: usage.reservedSeconds,
          dispatchedAt: usage.createdAt.toISOString(),
          timeoutMinutes: env.BILLING_STALE_CALL_TIMEOUT_MINUTES,
        },
      });
    }

    this.countCorrections('stale_call', report.staleCallsFinalized);
    this.countCorrections('manual_review', report.manualReviewsCreated);
    return report;
  }

  /**
   * Close concurrency leases whose expiry has passed.
   *
   * A leaked lease consumes a concurrency slot the customer paid for, so an
   * expired lease is released; the lease is only recreated by the runtime, never
   * by reconciliation, because reconciliation cannot confirm a live call.
   */
  async recoverLeases(limit = this.batchSize): Promise<BillingReconciliationReport> {
    const report = emptyReconciliationReport();
    const now = new Date();

    const expired = await this.prisma.callConcurrencyLease.findMany({
      where: { state: 'active', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { id: true, organizationId: true, callId: true, expiresAt: true },
    });

    for (const lease of expired) {
      const changed = await this.prisma.callConcurrencyLease.updateMany({
        where: { id: lease.id, state: 'active' },
        data: { state: 'released' },
      });
      if (changed.count === 0) continue;

      report.leasesRecovered += 1;
      await this.audit.log({
        organizationId: lease.organizationId,
        action: 'billing.lease_recovered',
        resourceType: 'call_concurrency_lease',
        resourceId: lease.id,
        metadata: { callId: lease.callId, expiredAt: lease.expiresAt.toISOString() },
      });
    }

    await this.publishConcurrencyGauge();
    this.countCorrections('lease', report.leasesRecovered);
    return report;
  }

  /** Backfill provider cost estimates and alert when coverage is too low. */
  async reconcileProviderCosts(limit = this.batchSize): Promise<BillingReconciliationReport> {
    const report = emptyReconciliationReport();
    report.costEventsEstimated = await this.providerCosts.estimateMissingCallCosts(limit);

    const since = new Date(Date.now() - 24 * 60 * MINUTE_MS);
    const coverage = await this.providerCosts.costCoverage(since);
    if (coverage.missingRatio > 0.01) {
      // Above one percent, margin reporting is running on incomplete data.
      this.logger.error(
        `Provider cost coverage gap: ${coverage.callsMissingCost}/${coverage.finalizedCalls} ` +
          `finalized calls in the last 24h have no cost event ` +
          `(${(coverage.missingRatio * 100).toFixed(2)}%)`,
      );
    }

    this.countCorrections('provider_cost', report.costEventsEstimated);
    return report;
  }

  /**
   * Publish contribution margin per plan.
   *
   * Margin uses recorded provider cost against the plan's list price. A plan
   * with no active subscriptions is skipped rather than reported as zero, since
   * zero would be indistinguishable from a real collapse in margin.
   */
  async publishMarginMetrics(): Promise<void> {
    const plans: PlanType[] = ['free', 'starter', 'growth', 'enterprise'];
    const since = new Date(Date.now() - 30 * 24 * 60 * MINUTE_MS);

    for (const plan of plans) {
      const subscriptions = await this.prisma.subscription.findMany({
        where: { plan, status: { in: ['active', 'trialing'] } },
        select: { organizationId: true },
      });
      if (subscriptions.length === 0) continue;

      const organizationIds = subscriptions.map((s) => s.organizationId);
      const costs = await this.prisma.providerCostEvent.aggregate({
        where: { organizationId: { in: organizationIds }, occurredAt: { gte: since } },
        _sum: { amount: true },
      });

      const revenue = subscriptions.length * this.monthlyPriceUsd(plan);
      if (revenue <= 0) continue;

      const cost = Number(costs._sum.amount ?? 0);
      this.metrics.planContributionMarginRatio.labels(plan).set((revenue - cost) / revenue);
    }
  }

  /** Run every repair in one pass and return the combined report. */
  async runAll(): Promise<BillingReconciliationReport> {
    const reports = [
      await this.reconcileBalances(),
      await this.expireBuckets(),
      await this.finalizeStaleCalls(),
      await this.recoverLeases(),
      await this.reconcileProviderCosts(),
    ];
    await this.publishMarginMetrics();
    return reports.reduce<BillingReconciliationReport>((merged, report) => {
      merged.organizationsChecked += report.organizationsChecked;
      merged.projectionCorrections += report.projectionCorrections;
      merged.expiredBuckets += report.expiredBuckets;
      merged.staleCallsFinalized += report.staleCallsFinalized;
      merged.leasesRecovered += report.leasesRecovered;
      merged.costEventsEstimated += report.costEventsEstimated;
      merged.manualReviewsCreated += report.manualReviewsCreated;
      return merged;
    }, emptyReconciliationReport());
  }

  /** Release seconds a stale call was holding, never below zero. */
  private async releaseReservation(organizationId: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    const balance = await this.prisma.organizationCreditBalance.findUnique({
      where: { organizationId },
      select: { reservedSeconds: true },
    });
    if (!balance) return;

    const releasable = Math.min(seconds, balance.reservedSeconds);
    if (releasable <= 0) return;

    await this.prisma.organizationCreditBalance.update({
      where: { organizationId },
      data: {
        reservedSeconds: { decrement: releasable },
        availableSeconds: { increment: releasable },
        version: { increment: 1 },
      },
    });
  }

  /** Mark a balance for human review without altering any customer figure. */
  private async flagForReview(
    organizationId: string,
    callId: string,
    reason: string,
  ): Promise<boolean> {
    const changed = await this.prisma.organizationCreditBalance.updateMany({
      where: { organizationId, reviewReason: null },
      data: { status: 'review', reviewReason: reason },
    });
    if (changed.count === 0) return false;

    await this.audit.log({
      organizationId,
      action: 'billing.manual_review_created',
      resourceType: 'organization_credit_balance',
      resourceId: organizationId,
      metadata: { callId, reason },
    });
    return true;
  }

  private async publishBalanceGauges(): Promise<void> {
    const totals = await this.prisma.organizationCreditBalance.aggregate({
      _sum: { availableSeconds: true, reservedSeconds: true },
    });
    this.metrics.billingAvailableSeconds.set(totals._sum.availableSeconds ?? 0);
    this.metrics.billingReservedSeconds.set(totals._sum.reservedSeconds ?? 0);
  }

  private async publishConcurrencyGauge(): Promise<void> {
    const active = await this.prisma.callConcurrencyLease.count({ where: { state: 'active' } });
    this.metrics.callsActiveGlobal.set(active);
  }

  private countCorrections(type: string, count: number): void {
    if (count > 0) this.metrics.billingReconciliationCorrectionsTotal.labels(type).inc(count);
  }

  /** Read from the same catalog checkout uses, so margin and pricing cannot drift. */
  private monthlyPriceUsd(plan: PlanType): number {
    return getPlanById(plan)?.monthlyPriceUsd ?? 0;
  }

  /**
   * Serialize per-organization repairs across API replicas.
   *
   * `pg_try_advisory_xact_lock` is scoped to the transaction, so the lock is
   * released when the transaction ends — including on crash. A session-scoped
   * lock would leak on a pooled connection and permanently wedge the
   * organization out of reconciliation.
   */
  private async withOrganizationLock<T>(
    organizationId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const key = this.lockKey(organizationId);
    return this.prisma.$transaction(async (tx) => {
      const [acquired] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}::int, ${key}::int) AS locked
      `;
      if (!acquired?.locked) {
        throw new Error(`Organization ${organizationId} is already being reconciled`);
      }
      return operation(tx);
    });
  }

  /** Stable 32-bit signed key derived from the organization UUID. */
  private lockKey(organizationId: string): number {
    let hash = 0;
    for (let i = 0; i < organizationId.length; i += 1) {
      hash = (Math.imul(hash, 31) + organizationId.charCodeAt(i)) | 0;
    }
    return hash;
  }
}
