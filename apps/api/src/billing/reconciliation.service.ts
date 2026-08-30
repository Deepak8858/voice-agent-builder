import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import type { PlanType } from '@voiceforge/shared';
import { getPlanById } from '@voiceforge/shared';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../common/metrics.service';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
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
 *
 * The Stripe comparison (`reportStripeDrift`) is the one exception to "repair":
 * it only counts and logs, because a heal driven by a comparison this young
 * would either double-grant credit or claw back credit a customer owns.
 */

export interface BillingReconciliationReport {
  organizationsChecked: number;
  projectionCorrections: number;
  expiredBuckets: number;
  staleCallsFinalized: number;
  leasesRecovered: number;
  costEventsEstimated: number;
  manualReviewsCreated: number;
  /** Stripe objects examined by the drift comparison (the drift denominator). */
  stripeObjectsCompared: number;
  /** Paid Stripe invoices with no matching `included` credit bucket. */
  stripePaidInvoicesWithoutCredit: number;
  /** Paid minute-pack Checkout sessions with no matching `purchased` bucket. */
  stripePaidPacksWithoutCredit: number;
  /** Subscriptions whose Stripe state disagrees with our row. */
  stripeSubscriptionDrift: number;
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
    stripeObjectsCompared: 0,
    stripePaidInvoicesWithoutCredit: 0,
    stripePaidPacksWithoutCredit: 0,
    stripeSubscriptionDrift: 0,
  };
}

/** Namespace for the advisory locks this service takes, so it cannot collide. */
const ADVISORY_LOCK_NAMESPACE = 947_231;

/**
 * Raised when a per-organization advisory lock is held elsewhere.
 *
 * Distinct from a generic failure so callers can treat contention as an
 * expected outcome under multiple replicas rather than as an error.
 */
export class OrganizationLockUnavailableError extends Error {
  constructor(readonly organizationId: string) {
    super(`Organization ${organizationId} is already being reconciled`);
    this.name = 'OrganizationLockUnavailableError';
  }
}

const MINUTE_MS = 60_000;

/**
 * Organizations per provider-cost aggregate query in the margin pass. Bounds
 * the size of the `IN` list so the query plan stays stable as tenants grow.
 */
const MARGIN_AGGREGATE_CHUNK_SIZE = 500;

/** Stripe's maximum page size, so a run makes as few API calls as possible. */
const STRIPE_PAGE_SIZE = 100;

/**
 * Grace period before a Stripe object's missing counterpart counts as drift. A
 * webhook still in flight, or being retried, is not drift; counting it would
 * bury the real cases under noise on every pass.
 */
const STRIPE_SETTLE_MS = 15 * MINUTE_MS;

/** Lookback for the comparison: one monthly cycle plus slack for retries. */
const STRIPE_LOOKBACK_MS = 35 * 24 * 60 * MINUTE_MS;

/**
 * Our statuses that assert a live Stripe subscription. `incomplete` is excluded
 * on purpose: Stripe drops those from the default listing once they expire, so
 * their absence is not evidence of drift.
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** Only the fields the drift comparison reads, mirroring the rest of `billing/`. */
interface StripeDriftInvoice {
  id: string;
  customer: unknown;
  subscription: unknown;
  amount_paid: number;
}

interface StripeDriftSession {
  id: string;
  customer: unknown;
  payment_status: string | null;
  metadata: Record<string, string> | null;
}

interface StripeDriftSubscription {
  id: string;
  status: string;
  items?: { data?: Array<{ price?: { id?: string | null } | null }> };
}

interface StripeListPage<T> {
  data: T[];
  has_more: boolean;
}

interface StripeDriftClient {
  invoices: {
    list(params: Record<string, unknown>): Promise<StripeListPage<StripeDriftInvoice>>;
  };
  subscriptions: {
    list(params: Record<string, unknown>): Promise<StripeListPage<StripeDriftSubscription>>;
  };
  checkout: {
    sessions: {
      list(params: Record<string, unknown>): Promise<StripeListPage<StripeDriftSession>>;
    };
  };
}

/**
 * One suspected disagreement between Stripe and us, re-checked against the
 * database before it is counted so a repair that landed in the meantime is not
 * reported as drift.
 */
type StripeDriftCandidate =
  | {
      kind: 'bucket';
      sourceType: 'included' | 'purchased';
      /** Stripe invoice ID or Checkout session ID; also the bucket's `sourceId`. */
      sourceId: string;
    }
  | {
      kind: 'subscription';
      stripeSubscriptionId: string;
      reason: 'status_mismatch' | 'price_mismatch' | 'absent_from_stripe';
      /** Null when Stripe no longer lists the subscription at all. */
      stripeStatus: string | null;
      stripePriceId: string | null;
      ourStatus: string;
      ourPriceId: string | null;
    };

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly stripe: StripeDriftClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly providerCosts: ProviderCostService,
    private readonly creditLedger: CreditLedgerService,
  ) {
    // Constructed exactly as `BillingService` and `StripeWebhookService` do it:
    // pinned to the installed SDK's API version, and null when there is no
    // secret key so the comparison no-ops in environments without Stripe.
    this.stripe = env.STRIPE_SECRET_KEY
      ? (new Stripe(env.STRIPE_SECRET_KEY, {
          apiVersion: Stripe.API_VERSION,
          maxNetworkRetries: 2,
        }) as unknown as StripeDriftClient)
      : null;
  }

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
        // Another replica holding the lock is the normal multi-replica outcome,
        // not a fault. Logging it at error level would bury real failures under
        // one line per contended organization on every pass.
        if (err instanceof OrganizationLockUnavailableError) {
          this.logger.debug(
            `Skipped organization ${balance.organizationId}: another replica holds the reconciliation lock.`,
          );
          continue;
        }
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
      // The advisory lock only serializes reconciliation replicas. Ledger
      // operations serialize on the balance row itself (`withLockedBalance`
      // takes FOR UPDATE), so without this row lock a commit or release could
      // land between the reads below and the write, and the write would
      // clobber it with stale figures.
      await tx.$queryRaw`
        SELECT id
        FROM organization_credit_balances
        WHERE organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;

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

      // Reservations already decrement bucket.remainingSeconds when they are
      // created. Subtracting reservedSeconds again would destroy one minute of
      // customer credit for every in-flight call.
      const expectedAvailable = bucketSeconds;
      const driftSeconds = expectedAvailable - balance.availableSeconds;

      // The authoritative reserved figure is the set of ledger `reservation`
      // entries with no same-call commit or release. `CallUsage` cannot stand
      // in for it: a crash before usage persistence leaves a reservation with
      // no usage row at all. A reservation younger than the stale-call timeout
      // may be committing right now, so any fresh outstanding reservation
      // defers the reserved repair to a later pass rather than clawing back an
      // in-flight minute; `finalizeStaleCalls` uses the same threshold, which
      // keeps the two repairs from disagreeing about the same reservation.
      const reservationCutoff = new Date(
        now.getTime() - env.BILLING_STALE_CALL_TIMEOUT_MINUTES * MINUTE_MS,
      );
      const [outstanding] = await tx.$queryRaw<
        Array<{ matureReservedSeconds: number; freshReservationCount: number }>
      >`
        SELECT
          COALESCE(SUM(r.seconds) FILTER (WHERE r.created_at < ${reservationCutoff}), 0)::int
            AS "matureReservedSeconds",
          COUNT(*) FILTER (WHERE r.created_at >= ${reservationCutoff})::int
            AS "freshReservationCount"
        FROM billing_ledger_entries r
        WHERE r.organization_id = ${organizationId}::uuid
          AND r.entry_type = 'reservation'
          AND r.reason_code = 'initial_minute'
          AND NOT EXISTS (
            SELECT 1
            FROM billing_ledger_entries f
            WHERE f.organization_id = r.organization_id
              AND f.call_id = r.call_id
              AND f.entry_type IN ('reservation_commit', 'reservation_release')
          )
      `;
      const reservedRepairDeferred = (outstanding?.freshReservationCount ?? 0) > 0;
      const expectedReserved = reservedRepairDeferred
        ? balance.reservedSeconds
        : (outstanding?.matureReservedSeconds ?? 0);
      const reservedDriftSeconds = expectedReserved - balance.reservedSeconds;

      if (driftSeconds === 0 && reservedDriftSeconds === 0) return null;

      if (reservedDriftSeconds !== 0) {
        this.logger.warn(
          `Repairing reservedSeconds for organization ${organizationId}: ` +
            `${balance.reservedSeconds} -> ${expectedReserved} (${reservedDriftSeconds}s drift).`,
        );
      }

      await tx.organizationCreditBalance.update({
        where: { organizationId },
        data: {
          availableSeconds: expectedAvailable,
          ...(reservedDriftSeconds !== 0 ? { reservedSeconds: expectedReserved } : {}),
          version: { increment: 1 },
        },
      });

      return {
        previousAvailableSeconds: balance.availableSeconds,
        correctedAvailableSeconds: expectedAvailable,
        reservedSeconds: balance.reservedSeconds,
        driftSeconds,
        previousReservedSeconds: balance.reservedSeconds,
        correctedReservedSeconds: expectedReserved,
        reservedDriftSeconds,
        reservedRepairDeferred,
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
   * Finalize calls the runtime abandoned, in either of the two ways it can.
   *
   * NEVER CONNECTED (`pending`/`releasing` with no `connectedAt`): a crash
   * between dispatch and `call_connected` holds the caller's reserved seconds
   * forever and permanently reduces their usable balance, so the reservation is
   * released.
   *
   * ABANDONED AFTER CONNECT (`connected`): nothing owes the customer anything
   * here — the reserved minute was committed on connect — but nothing finalized
   * the row either. `onEnded` is the only writer of `finalized` for a connected
   * call and it never arrives when the runtime dies mid-call, so the row sat at
   * `connected` for good. `estimateMissingCallCosts` only looks at `finalized`
   * rows, so the call's provider cost was never recorded and margin was
   * overstated by it — invisibly, because `costCoverage` counts only finalized
   * calls too, so the gap never reached the coverage alarm.
   *
   * Both shapes are read by one query and settled through one update, so this
   * sweep stays a single reviewed unscoped call site rather than three.
   * Staleness for the connected shape is measured on `updatedAt`, not
   * `createdAt`: a live call touches the row on every minute boundary, so a
   * `createdAt` cutoff would finalize long calls that are still up.
   */
  async finalizeStaleCalls(limit = this.batchSize): Promise<BillingReconciliationReport> {
    const report = emptyReconciliationReport();
    const cutoff = new Date(Date.now() - env.BILLING_STALE_CALL_TIMEOUT_MINUTES * MINUTE_MS);

    const stale = await this.prisma.callUsage.findMany({
      where: {
        OR: [
          {
            finalizationState: { in: ['pending', 'releasing'] },
            connectedAt: null,
            createdAt: { lt: cutoff },
          },
          { finalizationState: 'connected', updatedAt: { lt: cutoff } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        organizationId: true,
        callId: true,
        connectedAt: true,
        reservedSeconds: true,
        billableSeconds: true,
        debitedSeconds: true,
        createdAt: true,
        finalizationState: true,
      },
    });

    for (const usage of stale) {
      try {
        const abandonedAfterConnect = usage.finalizationState === 'connected';

        // A never-connected call with debited seconds did connect and something
        // else went wrong. Guessing at its duration would corrupt the
        // customer's balance, so it is routed to review instead.
        if (!abandonedAfterConnect && usage.debitedSeconds > 0) {
          const flagged = await this.flagForReview(
            usage.organizationId,
            usage.callId,
            'stale_call_with_debits',
          );
          if (flagged) report.manualReviewsCreated += 1;
          continue;
        }

        if (!abandonedAfterConnect) {
          // Claim the usage before touching the ledger. A failed release remains
          // retryable as `releasing`, while the ledger serializes a late
          // call_connected commit against this idempotent release.
          const claimed = await this.prisma.callUsage.updateMany({
            where: {
              id: usage.id,
              finalizationState: { in: ['pending', 'releasing'] },
              connectedAt: null,
              debitedSeconds: 0,
            },
            data: { finalizationState: 'releasing' },
          });
          if (claimed.count === 0) continue;

          await this.creditLedger.releaseReservation({
            organizationId: usage.organizationId,
            callId: usage.callId,
            idempotencyKey: `reconciliation:stale:${usage.callId}:release`,
          });
        }

        const finalized = await this.prisma.callUsage.updateMany({
          where: {
            id: usage.id,
            // Compare-and-set on the state this row was read in, so a live
            // `call_ended` that lands first wins and this pass does nothing.
            ...(abandonedAfterConnect
              ? { finalizationState: 'connected' }
              : { finalizationState: 'releasing', connectedAt: null }),
          },
          data: abandonedAfterConnect
            ? {
                finalizationState: 'finalized',
                disposition: 'abandoned_after_connect',
                // Ends the call where its metering stopped rather than at
                // `now`, so the provider cost this unblocks is attributed to
                // when the call actually ran. `rawConnectedSeconds` is left at
                // 0 deliberately: the runtime never reported a duration, and
                // `estimateMissingCallCosts` already falls back to the seconds
                // the customer was billed.
                endedAt: new Date(
                  (usage.connectedAt ?? usage.createdAt).getTime() +
                    usage.billableSeconds * 1000,
                ),
              }
            : {
                finalizationState: 'finalized',
                disposition: 'not_connected',
                endedAt: new Date(),
                reservedSeconds: 0,
                billableSeconds: 0,
              },
        });
        if (finalized.count === 0) continue;

        report.staleCallsFinalized += 1;
        await this.audit.log({
          organizationId: usage.organizationId,
          action: abandonedAfterConnect
            ? 'billing.abandoned_call_finalized'
            : 'billing.stale_call_finalized',
          resourceType: 'call_usage',
          resourceId: usage.callId,
          metadata: abandonedAfterConnect
            ? {
                billedSeconds: usage.billableSeconds,
                connectedAt: usage.connectedAt?.toISOString() ?? null,
                timeoutMinutes: env.BILLING_STALE_CALL_TIMEOUT_MINUTES,
              }
            : {
                releasedSeconds: usage.reservedSeconds,
                dispatchedAt: usage.createdAt.toISOString(),
                timeoutMinutes: env.BILLING_STALE_CALL_TIMEOUT_MINUTES,
              },
        });
      } catch (err) {
        this.logger.error(
          `Stale call finalization failed for ${usage.callId}: ${(err as Error).message}`,
        );
      }
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
   *
   * Enterprise is excluded: its catalog `monthlyPriceUsd` is a "from" floor for
   * the pricing page, not a contract value, so multiplying it by the
   * subscription count would report an invented revenue figure. Enterprise
   * margin needs the actual contracted amounts, which are not modelled yet.
   */
  async publishMarginMetrics(): Promise<void> {
    const plans: PlanType[] = ['free', 'starter', 'growth'];
    const since = new Date(Date.now() - 30 * 24 * 60 * MINUTE_MS);

    for (const plan of plans) {
      // Named for the plan rather than `subscriptions`: the tenant-scope
      // analyzer substitutes file-wide identifier initializers into a `where`
      // clause, so a local called `subscriptions` holding a `select:
      // { organizationId }` makes every later query that mentions
      // `stripe.subscriptions` look tenant-scoped and drop out of the ratchet.
      const planSubscriptions = await this.prisma.subscription.findMany({
        where: { plan, status: { in: ['active', 'trialing'] } },
        select: { organizationId: true, status: true },
      });
      if (planSubscriptions.length === 0) continue;

      // A trial bills nothing until it converts, so counting it at list price
      // invented revenue this business never collected — and reported a healthy
      // margin for a plan whose trials were burning provider cost for free,
      // which is the single thing this gauge exists to catch. Trials stay in the
      // cost aggregate below, because their minutes are real money out.
      const payingCount = planSubscriptions.filter((s) => s.status === 'active').length;
      const revenue = payingCount * this.monthlyPriceUsd(plan);
      if (revenue <= 0) continue;

      // Aggregated in fixed-size chunks. A single `IN` list over every
      // organization on a plan grows with the tenant count and turns into a
      // very large parameter list and a slow scan on each pass.
      const organizationIds = planSubscriptions.map((s) => s.organizationId);
      let cost = 0;
      for (let index = 0; index < organizationIds.length; index += MARGIN_AGGREGATE_CHUNK_SIZE) {
        const chunk = organizationIds.slice(index, index + MARGIN_AGGREGATE_CHUNK_SIZE);
        const costs = await this.prisma.providerCostEvent.aggregate({
          where: { organizationId: { in: chunk }, occurredAt: { gte: since } },
          _sum: { amount: true },
        });
        cost += Number(costs._sum.amount ?? 0);
      }

      this.metrics.planContributionMarginRatio.labels(plan).set((revenue - cost) / revenue);
    }
  }

  /**
   * Compare Stripe's record of what was paid and subscribed against our credit
   * buckets and subscription rows, and REPORT what disagrees.
   *
   * Strictly read-only on both sides: no Stripe call mutates anything, and no
   * row is written — not even an audit record, which is reserved here for
   * corrections that actually happened. Drift is counted so a full billing cycle
   * of it exists before anyone decides how to heal it; healing from a comparison
   * this young would either double-grant credit or claw back credit a customer
   * legitimately holds.
   *
   * ponytail: report-only for one billing cycle; auto-heal once drift data is in.
   */
  async reportStripeDrift(limit = this.batchSize): Promise<BillingReconciliationReport> {
    const report = emptyReconciliationReport();
    const stripe = this.stripe;
    if (!stripe) {
      this.logger.debug('Stripe is not configured; skipping the Stripe drift comparison.');
      return report;
    }

    const now = Date.now();
    const created = {
      gte: Math.floor((now - STRIPE_LOOKBACK_MS) / 1000),
      lte: Math.floor((now - STRIPE_SETTLE_MS) / 1000),
    };

    // A paid invoice carrying money with a subscription behind it is exactly
    // what `invoice.paid` grants included minutes for. Anything else — a zero
    // amount adjustment, a one-off invoice — never produces a bucket, so
    // including it would report drift that does not exist.
    const invoices = await this.listStripe('paid invoices', limit, (params) =>
      stripe.invoices.list({ status: 'paid', created, ...params }),
    );
    const paidInvoices = invoices.items.filter(
      (invoice) => invoice.amount_paid > 0 && typeof invoice.subscription === 'string',
    );

    // Checkout sessions cannot be filtered by metadata server-side, so pack
    // purchases are picked out of the pages after the fact.
    // ponytail: on an account with many subscription checkouts the cap can be
    // spent before the older pack sessions are reached. The truncation is logged
    // rather than hidden; there is no Stripe-side filter that would avoid it.
    const sessions = await this.listStripe('checkout sessions', limit, (params) =>
      stripe.checkout.sessions.list({ created, ...params }),
    );
    const paidPacks = sessions.items.filter(
      (session) =>
        session.payment_status === 'paid' && session.metadata?.['purchaseType'] === 'minute_pack',
    );

    // The default listing is every subscription Stripe has not canceled, with no
    // date filter: a subscription that started years ago is still live revenue.
    const live = await this.listStripe('subscriptions', limit, (params) =>
      stripe.subscriptions.list(params),
    );

    report.stripeObjectsCompared = paidInvoices.length + paidPacks.length + live.items.length;

    const suspects = new Map<string, StripeDriftCandidate[]>();
    const suspect = (organizationId: string, candidate: StripeDriftCandidate): void => {
      const queued = suspects.get(organizationId);
      if (queued) queued.push(candidate);
      else suspects.set(organizationId, [candidate]);
    };

    // --- money collected by Stripe against the credit it should have bought ---
    const paid: Array<{ sourceType: 'included' | 'purchased'; sourceId: string; customer: unknown }> =
      [
        ...paidInvoices.map((invoice) => ({
          sourceType: 'included' as const,
          sourceId: invoice.id,
          customer: invoice.customer,
        })),
        ...paidPacks.map((session) => ({
          sourceType: 'purchased' as const,
          sourceId: session.id,
          customer: session.customer,
        })),
      ];
    const organizationByCustomer = await this.organizationsByStripeCustomer(
      paid.map((entry) => entry.customer).filter((id): id is string => typeof id === 'string'),
    );
    // One query for the whole batch, so only the genuinely missing ones are
    // re-checked under a lock and an organization with no suspicion is never
    // locked at all. Scoped to the organizations that own the Stripe customers
    // above: a bucket belonging to anyone else can never satisfy one of these
    // payments, so reading wider would be both slower and untenanted.
    const grants = await this.prisma.billingCreditBucket.findMany({
      where: {
        organizationId: { in: [...new Set(organizationByCustomer.values())] },
        sourceType: { in: ['included', 'purchased'] },
        sourceId: { in: paid.map((entry) => entry.sourceId) },
      },
      select: { organizationId: true, sourceType: true, sourceId: true },
    });
    const granted = new Set(
      grants.map((bucket) => `${bucket.organizationId}|${bucket.sourceType}|${bucket.sourceId}`),
    );

    for (const entry of paid) {
      const organizationId =
        typeof entry.customer === 'string'
          ? organizationByCustomer.get(entry.customer)
          : undefined;
      if (!organizationId) {
        // Money collected against a Stripe customer no organization claims: no
        // credit can have been granted for it anywhere.
        this.countStripeDrift(report, entry.sourceType);
        this.logger.warn(
          `Stripe drift: paid ${entry.sourceType === 'included' ? 'invoice' : 'minute pack'} ` +
            `${entry.sourceId} belongs to Stripe customer ${String(entry.customer)}, which no ` +
            `organization owns — no credit was granted for it. Reported only.`,
        );
        continue;
      }
      if (granted.has(`${organizationId}|${entry.sourceType}|${entry.sourceId}`)) continue;
      suspect(organizationId, {
        kind: 'bucket',
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
      });
    }

    // --- Stripe's subscription state against ours ---------------------------
    const ourSubscriptions = await this.prisma.subscription.findMany({
      where: { stripeSubscriptionId: { in: live.items.map((subscription) => subscription.id) } },
      select: { organizationId: true, stripeSubscriptionId: true, status: true, stripePriceId: true },
    });
    const ourByStripeId = new Map(
      ourSubscriptions.map((subscription) => [subscription.stripeSubscriptionId, subscription]),
    );

    for (const subscription of live.items) {
      const ours = ourByStripeId.get(subscription.id);
      const stripePriceId = subscription.items?.data?.[0]?.price?.id ?? null;
      if (!ours) {
        report.stripeSubscriptionDrift += 1;
        this.logger.warn(
          `Stripe drift: subscription ${subscription.id} is ${subscription.status} in Stripe ` +
            `(price ${String(stripePriceId)}) but no organization has it on record. Reported only.`,
        );
        continue;
      }
      const reason =
        ours.status !== subscription.status
          ? 'status_mismatch'
          : ours.stripePriceId !== stripePriceId
            ? 'price_mismatch'
            : null;
      if (!reason) continue;
      suspect(ours.organizationId, {
        kind: 'subscription',
        stripeSubscriptionId: subscription.id,
        reason,
        stripeStatus: subscription.status,
        stripePriceId,
        ourStatus: ours.status,
        ourPriceId: ours.stripePriceId,
      });
    }

    // The reverse direction — we believe a subscription is live and Stripe does
    // not list it — is only sound when the listing above was complete. A
    // truncated list would make every unseen subscription look canceled, so the
    // check is skipped rather than guessed at.
    if (live.truncated) {
      this.logger.warn(
        'Stripe drift: the subscription listing was incomplete, so subscriptions we believe are ' +
          'live were NOT checked for cancellation in Stripe this pass.',
      );
    } else {
      const liveIds = new Set(live.items.map((subscription) => subscription.id));
      const claimedLive = await this.prisma.subscription.findMany({
        where: {
          status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
          stripeSubscriptionId: { not: null },
        },
        orderBy: { updatedAt: 'asc' },
        take: limit,
        select: { organizationId: true, stripeSubscriptionId: true, status: true, stripePriceId: true },
      });
      if (claimedLive.length === limit) {
        this.logger.warn(
          `Stripe drift: stopped at ${limit} locally-live subscription(s); the remainder was ` +
            'NOT checked for cancellation in Stripe this pass.',
        );
      }
      for (const ours of claimedLive) {
        if (!ours.stripeSubscriptionId || liveIds.has(ours.stripeSubscriptionId)) continue;
        suspect(ours.organizationId, {
          kind: 'subscription',
          stripeSubscriptionId: ours.stripeSubscriptionId,
          reason: 'absent_from_stripe',
          stripeStatus: null,
          stripePriceId: null,
          ourStatus: ours.status,
          ourPriceId: ours.stripePriceId,
        });
      }
    }

    // --- confirm each suspicion against the database, then count it ---------
    for (const [organizationId, candidates] of suspects) {
      try {
        await this.confirmStripeDrift(organizationId, candidates, report);
      } catch (err) {
        // Contention means a repair is working on this organization right now;
        // its state is about to change, so there is nothing to report yet.
        if (err instanceof OrganizationLockUnavailableError) {
          this.logger.debug(
            `Skipped Stripe drift check for organization ${organizationId}: another replica holds the reconciliation lock.`,
          );
          continue;
        }
        this.logger.error(
          `Stripe drift check failed for organization ${organizationId}: ${(err as Error).message}`,
        );
      }
    }

    return report;
  }

  /**
   * Re-read our side under the same advisory lock the repairs take and count
   * only the disagreements that survive.
   *
   * The bulk queries above ran before this, so a webhook or repair may have
   * landed in between; counting without this re-read would inflate the drift
   * figure with work that already completed. Read-only: the transaction exists
   * for the lock and a consistent snapshot, and writes nothing.
   */
  private async confirmStripeDrift(
    organizationId: string,
    candidates: StripeDriftCandidate[],
    report: BillingReconciliationReport,
  ): Promise<void> {
    await this.withOrganizationLock(organizationId, async (tx) => {
      for (const candidate of candidates) {
        if (candidate.kind === 'bucket') {
          const bucket = await tx.billingCreditBucket.findUnique({
            where: {
              organizationId_sourceType_sourceId: {
                organizationId,
                sourceType: candidate.sourceType,
                sourceId: candidate.sourceId,
              },
            },
            select: { id: true },
          });
          if (bucket) continue;
          this.countStripeDrift(report, candidate.sourceType);
          this.logger.warn(
            `Stripe drift: organization ${organizationId} paid Stripe ` +
              `${candidate.sourceType === 'included' ? 'invoice' : 'minute pack'} ` +
              `${candidate.sourceId} but holds no ${candidate.sourceType} credit bucket for it. ` +
              'Reported only; no credit was granted.',
          );
          continue;
        }

        const ours = await tx.subscription.findUnique({
          where: { organizationId },
          select: { status: true, stripePriceId: true, stripeSubscriptionId: true },
        });
        // A different subscription now means the row moved on; whatever was
        // observed no longer describes this organization.
        if (!ours || ours.stripeSubscriptionId !== candidate.stripeSubscriptionId) continue;
        const stillDrifted =
          candidate.reason === 'status_mismatch'
            ? ours.status !== candidate.stripeStatus
            : candidate.reason === 'price_mismatch'
              ? ours.stripePriceId !== candidate.stripePriceId
              : LIVE_SUBSCRIPTION_STATUSES.has(ours.status);
        if (!stillDrifted) continue;

        report.stripeSubscriptionDrift += 1;
        this.logger.warn(
          `Stripe drift (${candidate.reason}): organization ${organizationId} subscription ` +
            `${candidate.stripeSubscriptionId} — Stripe says status=${String(candidate.stripeStatus)} ` +
            `price=${String(candidate.stripePriceId)}, we say status=${ours.status} ` +
            `price=${String(ours.stripePriceId)}. Reported only.`,
        );
      }
    });
  }

  private countStripeDrift(
    report: BillingReconciliationReport,
    sourceType: 'included' | 'purchased',
  ): void {
    if (sourceType === 'included') report.stripePaidInvoicesWithoutCredit += 1;
    else report.stripePaidPacksWithoutCredit += 1;
  }

  /** Map Stripe customer IDs to the organizations that own them. */
  private async organizationsByStripeCustomer(
    stripeCustomerIds: string[],
  ): Promise<Map<string, string>> {
    if (stripeCustomerIds.length === 0) return new Map();
    const owners = await this.prisma.subscription.findMany({
      where: { stripeCustomerId: { in: [...new Set(stripeCustomerIds)] } },
      select: { organizationId: true, stripeCustomerId: true },
    });
    return new Map(
      owners.flatMap((owner) =>
        owner.stripeCustomerId ? [[owner.stripeCustomerId, owner.organizationId] as const] : [],
      ),
    );
  }

  /**
   * Page through a Stripe list endpoint up to a hard object cap.
   *
   * The cap is what keeps a run bounded on a large account; hitting it is
   * logged, never silently truncated, and reported back so callers can decide
   * whether a comparison that needs a complete list is still sound. A failed
   * Stripe call is logged loudly and yields no items, so one broken endpoint
   * cannot take the other comparisons down with it.
   */
  private async listStripe<T extends { id: string }>(
    label: string,
    limit: number,
    list: (params: Record<string, unknown>) => Promise<StripeListPage<T>>,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    try {
      for (;;) {
        const remaining = limit - items.length;
        if (remaining <= 0) {
          this.logger.warn(
            `Stripe drift: stopped at the ${limit}-object cap for ${label}; the remainder was ` +
              'NOT compared this pass.',
          );
          return { items, truncated: true };
        }
        const startingAfter = items.at(-1)?.id;
        const page = await list({
          limit: Math.min(STRIPE_PAGE_SIZE, remaining),
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        items.push(...page.data);
        // An empty page ends the walk even if Stripe claims more, so a
        // misbehaving response cannot spin this loop forever.
        if (!page.has_more || page.data.length === 0) return { items, truncated: false };
      }
    } catch (err) {
      this.logger.error(
        `Stripe drift: listing ${label} failed, so nothing was compared for it: ${(err as Error).message}`,
      );
      return { items: [], truncated: true };
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
      await this.reportStripeDrift(),
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
      merged.stripeObjectsCompared += report.stripeObjectsCompared;
      merged.stripePaidInvoicesWithoutCredit += report.stripePaidInvoicesWithoutCredit;
      merged.stripePaidPacksWithoutCredit += report.stripePaidPacksWithoutCredit;
      merged.stripeSubscriptionDrift += report.stripeSubscriptionDrift;
      return merged;
    }, emptyReconciliationReport());
  }

  /**
   * Mark a balance for human review without altering any customer figure.
   *
   * `reviewReason: null` in the `where` is a dedupe on the *flag*, not on the
   * incidents: it keeps the first reason (the one an operator will read) from
   * being overwritten by later ones. It used to short-circuit the audit write
   * too, so every incident after the first vanished — an organization flagged
   * for one stale call looked identical to one flagged for two hundred, and the
   * operator clearing the review had no way to tell. Each incident is now
   * audited whether or not it is the one that set the flag; only the return
   * value (which feeds `manualReviewsCreated`) still counts flag transitions.
   *
   * `version` is bumped with the flag so cache/ETag readers of the projection
   * see the status change, the same way `clearBalanceReview` bumps it back.
   */
  private async flagForReview(
    organizationId: string,
    callId: string,
    reason: string,
  ): Promise<boolean> {
    const changed = await this.prisma.organizationCreditBalance.updateMany({
      where: { organizationId, reviewReason: null },
      data: { status: 'review', reviewReason: reason, version: { increment: 1 } },
    });

    await this.audit.log({
      organizationId,
      action:
        changed.count > 0 ? 'billing.manual_review_created' : 'billing.manual_review_incident',
      resourceType: 'organization_credit_balance',
      resourceId: organizationId,
      metadata: { callId, reason },
    });
    return changed.count > 0;
  }

  /**
   * The inverse of `flagForReview`, and the reason it has to exist: nothing in
   * the codebase ever moved `status` back to `active`. `entitlement.service.ts`
   * refuses every call on ANY non-`active` status, so both `review` (set above)
   * and `blocked` (set by the partial-refund path in `credit-ledger.service.ts`)
   * killed an organization's inbound and outbound calling until someone ran an
   * UPDATE by hand.
   *
   * `reviewReason` is cleared with it, not merely alongside it: it is
   * `flagForReview`'s own dedupe guard, so an organization left with a stale
   * non-null reason can never be flagged again. Clearing it is what re-arms
   * review, not just what restores calling.
   *
   * No customer figure moves — `availableSeconds`, `reservedSeconds`, buckets
   * and ledger entries are all untouched. This restores permission to call; it
   * does not hand out credit.
   *
   * `updateMany` rather than `update`, so an organization with no balance row
   * keeps having none instead of one being invented for it, and the `where`
   * repeats the values just read so a concurrent flag or clear loses the race
   * instead of being silently overwritten. That compare-and-set is why this
   * needs no advisory lock.
   */
  async clearBalanceReview(
    organizationId: string,
    clearedBy: string,
  ): Promise<{
    cleared: boolean;
    previousStatus: string | null;
    previousReviewReason: string | null;
  }> {
    const balance = await this.prisma.organizationCreditBalance.findUnique({
      where: { organizationId },
      select: { status: true, reviewReason: true },
    });
    if (!balance) {
      return { cleared: false, previousStatus: null, previousReviewReason: null };
    }

    const previous = {
      previousStatus: balance.status,
      previousReviewReason: balance.reviewReason,
    };
    // Idempotent: already clear is a no-op, not a second audit entry.
    if (balance.status === 'active' && balance.reviewReason === null) {
      return { cleared: false, ...previous };
    }

    const changed = await this.prisma.organizationCreditBalance.updateMany({
      where: { organizationId, status: balance.status, reviewReason: balance.reviewReason },
      data: { status: 'active', reviewReason: null, version: { increment: 1 } },
    });
    if (changed.count === 0) return { cleared: false, ...previous };

    await this.audit.log({
      organizationId,
      action: 'billing.manual_review_cleared',
      resourceType: 'organization_credit_balance',
      resourceId: organizationId,
      metadata: {
        clearedBy,
        previousStatus: balance.status,
        previousReviewReason: balance.reviewReason,
      },
    });
    return { cleared: true, ...previous };
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
    return this.prisma.$transaction(async (tx) => {
      // `hashtextextended` gives a 64-bit key derived from the full UUID, so two
      // organizations do not share a lock and block each other's repairs. The
      // namespace is folded into the seed to keep this service's locks disjoint
      // from any other advisory lock in the database.
      const [acquired] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${`billing:reconciliation:${organizationId}`}, ${ADVISORY_LOCK_NAMESPACE})
        ) AS locked
      `;
      if (!acquired?.locked) {
        throw new OrganizationLockUnavailableError(organizationId);
      }
      return operation(tx);
    });
  }
}
