import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { MetricsService } from '../common/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Provider cost tracking.
 *
 * These records answer "what did serving this traffic cost us", which is a
 * different question from "what did we charge the customer". They are kept in
 * `provider_cost_events` and are never written to `billing_ledger_entries`:
 * a cost correction must never move a customer balance.
 *
 * Actual provider usage arrives late (hours, sometimes a day), so a connected
 * call is recorded immediately as a versioned estimate and replaced in place
 * when the real figure lands.
 */

/** Cost categories are tracked separately so margin regressions are attributable. */
export const PROVIDER_COST_CATEGORIES = {
  /** LLM inference for the conversation itself. */
  llm: 'llm',
  /** Voice agent runtime (media pipeline, STT/TTS bundled by the provider). */
  agentRuntime: 'agent_runtime',
  /** PSTN/SIP trunking minutes. */
  sipTrunk: 'sip_trunk',
  /**
   * Recurring carrier rental for a phone number. Charged per number per month
   * whether or not the number takes a single call, so it is a cost the minute
   * categories above can never account for.
   */
  numberRental: 'number_rental',
} as const;

export type ProviderCostCategory =
  (typeof PROVIDER_COST_CATEGORIES)[keyof typeof PROVIDER_COST_CATEGORIES];

/**
 * Bumped whenever the estimation formula changes, so an old estimate is
 * distinguishable from a current one and can be re-estimated deliberately.
 */
export const PROVIDER_COST_ESTIMATE_VERSION = 1;

const SECONDS_PER_MINUTE = 60;

export interface ProviderCostInput {
  organizationId: string;
  workspaceId?: string | null;
  callId?: string | null;
  provider: string;
  serviceCategory: ProviderCostCategory | string;
  /** Stable per-provider key. Re-recording the same key updates in place. */
  idempotencyKey: string;
  measuredUnit: string;
  quantity: number;
  amountUsd: number;
  occurredAt: Date;
  providerUsageId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EstimateConnectedCallInput {
  organizationId: string;
  workspaceId?: string | null;
  callId: string;
  provider: string;
  connectedSeconds: number;
  occurredAt: Date;
  serviceCategory?: ProviderCostCategory | string;
}

export interface ProviderCostCoverage {
  finalizedCalls: number;
  callsMissingCost: number;
  /** Fraction in [0, 1]. Zero when there is nothing to cover. */
  missingRatio: number;
}

@Injectable()
export class ProviderCostService {
  private readonly logger = new Logger(ProviderCostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /** USD reserved per connected minute when no actual provider figure exists yet. */
  get reservePerMinuteUsd(): number {
    return env.BILLING_VARIABLE_COST_RESERVE_USD_PER_MINUTE;
  }

  /**
   * Record a connected call at the configured reserve rate.
   *
   * Started minutes are charged as whole minutes, matching how the customer
   * side rounds, so estimated margin is not flattered by partial minutes.
   */
  async estimateConnectedCall(input: EstimateConnectedCallInput): Promise<void> {
    const minutes = Math.ceil(Math.max(input.connectedSeconds, 0) / SECONDS_PER_MINUTE);
    const amountUsd = this.round6(minutes * this.reservePerMinuteUsd);

    await this.record(
      {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId ?? null,
        callId: input.callId,
        provider: input.provider,
        serviceCategory: input.serviceCategory ?? PROVIDER_COST_CATEGORIES.agentRuntime,
        idempotencyKey: this.estimateKey(input.callId, input.serviceCategory),
        measuredUnit: 'minute',
        quantity: minutes,
        amountUsd,
        occurredAt: input.occurredAt,
        metadata: {
          reserveUsdPerMinute: this.reservePerMinuteUsd,
          connectedSeconds: input.connectedSeconds,
        },
      },
      true,
    );
  }

  /** Record a figure reported by the provider, replacing any prior estimate. */
  async recordActualCost(input: ProviderCostInput): Promise<void> {
    await this.record(input, false);
  }

  private async record(input: ProviderCostInput, isEstimate: boolean): Promise<void> {
    const quantity = new Prisma.Decimal(this.round6(input.quantity));
    const amount = new Prisma.Decimal(this.round6(input.amountUsd));
    const key = {
      provider: input.provider,
      idempotencyKey: input.idempotencyKey,
    };

    const { previous, persisted } = await this.prisma.$transaction(async (tx) => {
      // Serialize the read/upsert pair across replicas. Without this lock, two
      // replays can both observe no prior row and both publish the full amount.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${input.provider}\0${input.idempotencyKey}`}, 0)
        )
      `;
      const previous = await tx.providerCostEvent.findUnique({
        where: { provider_idempotencyKey: key },
        select: { amount: true, isEstimate: true, serviceCategory: true },
      });
      const persisted = await tx.providerCostEvent.upsert({
        where: { provider_idempotencyKey: key },
        create: {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId ?? null,
          callId: input.callId ?? null,
          provider: input.provider,
          serviceCategory: input.serviceCategory,
          providerUsageId: input.providerUsageId ?? null,
          idempotencyKey: input.idempotencyKey,
          measuredUnit: input.measuredUnit,
          quantity,
          amount,
          isEstimate,
          estimateVersion: isEstimate ? PROVIDER_COST_ESTIMATE_VERSION : 0,
          occurredAt: input.occurredAt,
          reconciledAt: isEstimate ? null : new Date(),
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
        update: {
          // An actual figure supersedes an estimate. An estimate must never
          // overwrite an actual, so the estimate path leaves settled rows alone.
          ...(isEstimate
            ? {}
            : {
                quantity,
                amount,
                isEstimate: false,
                estimateVersion: 0,
                reconciledAt: new Date(),
                providerUsageId: input.providerUsageId ?? null,
                metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
              }),
        },
        select: { amount: true, isEstimate: true, serviceCategory: true },
      });
      return { previous, persisted };
    });

    const persistedAmount = Number(persisted.amount);
    const persistedLabels = this.metrics.providerCostUsd.labels(
      input.provider,
      persisted.serviceCategory,
      String(persisted.isEstimate),
    );
    if (!previous) {
      persistedLabels.inc(persistedAmount);
      return;
    }

    const previousAmount = Number(previous.amount);
    if (
      previous.isEstimate === persisted.isEstimate &&
      previous.serviceCategory === persisted.serviceCategory
    ) {
      const delta = this.round6(persistedAmount - previousAmount);
      if (delta !== 0) persistedLabels.inc(delta);
      return;
    }

    this.metrics.providerCostUsd
      .labels(input.provider, previous.serviceCategory, String(previous.isEstimate))
      .dec(previousAmount);
    persistedLabels.inc(persistedAmount);
  }

  /**
   * Estimate costs for finalized calls that still have no cost event.
   *
   * Bounded by `limit` so a backlog is worked down over successive runs rather
   * than in one unbounded transaction.
   */
  async estimateMissingCallCosts(limit = 100): Promise<number> {
    const calls = await this.prisma.callUsage.findMany({
      where: {
        finalizationState: 'finalized',
        connectedAt: { not: null },
        call: { providerCostEvents: { none: {} } },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: {
        organizationId: true,
        workspaceId: true,
        callId: true,
        provider: true,
        rawConnectedSeconds: true,
        billableSeconds: true,
        endedAt: true,
        connectedAt: true,
      },
    });

    let estimated = 0;
    for (const call of calls) {
      // `call_usages.call_id` is nullable since the retention sweep stopped
      // cascading billing rows away, and a purged call has no duration or
      // provider left to estimate a cost from. The `call:` relation filter above
      // already excludes these rows; this makes it true for the type system too.
      if (call.callId === null) continue;
      try {
        await this.estimateConnectedCall({
          organizationId: call.organizationId,
          workspaceId: call.workspaceId,
          callId: call.callId,
          provider: call.provider,
          connectedSeconds: call.rawConnectedSeconds || call.billableSeconds,
          occurredAt: call.endedAt ?? call.connectedAt ?? new Date(),
        });
        estimated += 1;
      } catch (err) {
        // One malformed row must not stop the batch.
        this.logger.error(
          `Failed to estimate provider cost for call ${call.callId}: ${(err as Error).message}`,
        );
      }
    }
    return estimated;
  }

  /**
   * Record this calendar month's carrier rental for each active phone number.
   *
   * `costPerMonth` was written on every provisioned number and read by nothing,
   * so reported margin counted every customer-facing minute and none of the
   * recurring rentals underneath them. A rented number costs money every month
   * whether or not it takes a call, and no call-derived cost event can ever
   * represent it — hence `callId` is left null.
   *
   * The key is `phone_number:<id>:<YYYY-MM>`: one row per number per month, so
   * re-running inside the same month updates in place instead of double
   * counting. Numbers already recorded for the month are excluded from the
   * candidate query, which is what lets `limit` work a large fleet down over
   * successive runs instead of rewriting the same first page every pass.
   *
   * The run stamps the CURRENT month, because that is the month whose traffic
   * the rental is paying for: the margin gauge sums a trailing window, and a
   * current-month row lands inside the same window as the revenue it supported.
   * Stamping a closed month would push cost out of that window.
   *
   * No pro-rating. The carrier bills a full month at provisioning and again on
   * each monthly anniversary, and nothing here knows that anniversary date, so
   * any fraction would be invented.
   * ponytail: a number provisioned or released mid-month is booked at a full
   * month, which overstates cost for that month — the safe direction for a
   * margin alert. Pro-rate only when the carrier invoice is imported, which
   * would supersede these figures through the same idempotency key anyway.
   */
  async recordNumberRentals(limit = 100): Promise<number> {
    const occurredAt = new Date();
    const month = occurredAt.toISOString().slice(0, 7);

    // Which numbers already have this month's row, so the batch makes progress
    // instead of re-recording the same page forever.
    // ponytail: the exclusion list grows with the rented fleet (one id per
    // number recorded this month). Add a `phoneNumberId` column on
    // ProviderCostEvent and anti-join on it if that list ever gets unwieldy.
    const alreadyRecorded = await this.prisma.providerCostEvent.findMany({
      where: {
        serviceCategory: PROVIDER_COST_CATEGORIES.numberRental,
        idempotencyKey: { endsWith: `:${month}` },
      },
      select: { idempotencyKey: true },
    });
    const recordedNumberIds = alreadyRecorded.map((row) => row.idempotencyKey.split(':')[1] ?? '');

    // `costPerMonth: { gt: 0 }` is what excludes BYO: a brought-in number is
    // stored at 0 because that tenant pays its own carrier, so the platform has
    // no rental to book for it.
    //
    // No predicate here is comment-only on purpose: the tenant-scope analyzer
    // substitutes file-wide identifier initializers into the `where` text it
    // tests, so a comment inside the literal that happens to name a local
    // holding a `select: { workspaceId }` makes this platform-wide sweep look
    // tenant-scoped and silently drop out of the ratchet.
    const rentedNumbers = await this.prisma.twilioPhoneNumber.findMany({
      where: {
        status: 'active',
        costPerMonth: { gt: 0 },
        ...(recordedNumberIds.length > 0 ? { id: { notIn: recordedNumberIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        costPerMonth: true,
        workspaceId: true,
        // A number is workspace-scoped and a cost event needs an organization.
        // It is read from this number's own workspace so one tenant's rental can
        // never be attributed to another.
        workspace: { select: { organizationId: true } },
      },
    });

    let recorded = 0;
    for (const number of rentedNumbers) {
      try {
        await this.recordActualCost({
          organizationId: number.workspace.organizationId,
          workspaceId: number.workspaceId,
          provider: 'twilio',
          serviceCategory: PROVIDER_COST_CATEGORIES.numberRental,
          idempotencyKey: `phone_number:${number.id}:${month}`,
          measuredUnit: 'month',
          quantity: 1,
          amountUsd: Number(number.costPerMonth),
          occurredAt,
          // The raw E.164 number is deliberately NOT copied in here. Erasing an
          // organization releases and deletes its `twilioPhoneNumber` rows, but
          // cost events are kept for accounting, so a number stored in this
          // metadata would outlive the erasure that was supposed to remove it.
          // `phoneNumberId` identifies the rental for any reconciliation, and the
          // number itself can be resolved from that row while it still exists.
          metadata: { phoneNumberId: number.id, month },
        });
        recorded += 1;
      } catch (err) {
        // One malformed row must not stop the batch.
        this.logger.error(
          `Failed to record the monthly rental for phone number ${number.id}: ${(err as Error).message}`,
        );
      }
    }
    return recorded;
  }

  /**
   * Share of finalized calls with no provider cost attached.
   *
   * The plan treats sustained coverage below 99% as an alert: it means margin
   * reporting is running on incomplete data.
   */
  async costCoverage(since: Date): Promise<ProviderCostCoverage> {
    const [finalizedCalls, callsMissingCost] = await Promise.all([
      this.prisma.callUsage.count({
        where: { finalizationState: 'finalized', endedAt: { gte: since } },
      }),
      this.prisma.callUsage.count({
        where: {
          finalizationState: 'finalized',
          endedAt: { gte: since },
          call: { providerCostEvents: { none: {} } },
        },
      }),
    ]);

    return {
      finalizedCalls,
      callsMissingCost,
      missingRatio: finalizedCalls === 0 ? 0 : callsMissingCost / finalizedCalls,
    };
  }

  private estimateKey(callId: string, category?: ProviderCostCategory | string): string {
    const suffix = category ?? PROVIDER_COST_CATEGORIES.agentRuntime;
    return `estimate:call:${callId}:${suffix}:v${PROVIDER_COST_ESTIMATE_VERSION}`;
  }

  /** Match the Decimal(20,6) column so round-tripping never shifts a total. */
  private round6(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
  }
}
