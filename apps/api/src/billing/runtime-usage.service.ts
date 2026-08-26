import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RuntimeUsageDecision, RuntimeUsageEvent } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CallAdmissionService } from './call-admission.service';
import { CreditLedgerService, type CreditBalance } from './credit-ledger.service';

const SECONDS_PER_MINUTE = 60;

/**
 * How long a delivery may hold an unfinished event before another delivery is
 * allowed to take it over. Long enough that a slow ledger transaction is never
 * duplicated, short enough that a process killed mid-event does not strand the
 * call's metering until the call ends.
 */
const CLAIM_LEASE_MS = 60_000;

/** Bounded wait for the holder of a claim to publish its decision. */
const CONTENDED_POLL_INTERVAL_MS = 25;
const CONTENDED_POLL_ATTEMPTS = 20;

type EventClaim =
  | { status: 'claimed' }
  | { status: 'replay'; decision: RuntimeUsageDecision }
  | { status: 'contended' };

/**
 * Metering for a live call.
 *
 * The runtime reports what happened; this service decides what it costs and
 * whether the call may continue. Every event is persisted before it is acted
 * on, and a repeated `eventId` returns the original decision rather than
 * charging twice — the runtime retries on network failure, so at-least-once
 * delivery is assumed.
 *
 * At-least-once also means two deliveries of the same event can arrive at the
 * same instant, on different instances. Reading for a prior decision is not
 * enough to stop that: both readers see none and both charge. So exactly-once
 * is enforced by an atomic claim on the event row — only the delivery that wins
 * the claim runs any side effect, and the loser waits for that decision and
 * returns it, so both callers answer the runtime identically.
 *
 * The tenant is never taken from the request body alone: the call is loaded and
 * the organization on the persisted row must match the claimed one.
 */
@Injectable()
export class RuntimeUsageService {
  private readonly logger = new Logger(RuntimeUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditLedger: CreditLedgerService,
    private readonly admission: CallAdmissionService,
  ) {}

  async handleEvent(event: RuntimeUsageEvent): Promise<RuntimeUsageDecision> {
    const call = await this.prisma.call.findFirst({
      where: { id: event.callId, organizationId: event.organizationId },
      select: { id: true, workspaceId: true, organizationId: true },
    });
    if (!call) {
      // Fail closed: an unknown or cross-tenant call is never granted minutes.
      this.logger.warn(
        `Runtime usage event ${event.eventId} referenced call ${event.callId} outside organization ${event.organizationId}.`,
      );
      return this.denyRetryable(event);
    }

    const claim = await this.claimEvent(event);
    if (claim.status === 'replay') {
      return claim.decision;
    }
    if (claim.status === 'contended') {
      // Another delivery holds the event and has not published a decision yet.
      // Acting anyway would double-charge, so the runtime is told to retry.
      this.logger.warn(
        `Runtime usage event ${event.eventId} is still being processed by another delivery.`,
      );
      return this.denyRetryable(event);
    }

    let decision: RuntimeUsageDecision;
    try {
      decision = await this.decide(event, call.workspaceId);
    } catch (err) {
      // The claim must not outlive a failed attempt, or a retry of a genuinely
      // unprocessed event would be refused until the lease expires.
      await this.releaseClaim(event);
      throw err;
    }

    await this.prisma.runtimeUsageEvent.update({
      where: {
        organizationId_eventId: {
          organizationId: event.organizationId,
          eventId: event.eventId,
        },
      },
      data: {
        decision: decision as unknown as Prisma.InputJsonValue,
        processedAt: new Date(),
      },
    });

    return decision;
  }

  /**
   * Take exclusive ownership of an event, or report why we cannot.
   *
   * The insert is the claim: the `(organizationId, eventId)` unique index makes
   * exactly one concurrent delivery succeed, and the loser is told apart from a
   * plain retry by what the stored row already contains. A claim whose holder
   * died is reclaimable after {@link CLAIM_LEASE_MS} so a crash cannot freeze a
   * call's metering.
   */
  private async claimEvent(event: RuntimeUsageEvent): Promise<EventClaim> {
    const now = new Date();
    try {
      await this.prisma.runtimeUsageEvent.create({
        data: {
          organizationId: event.organizationId,
          callId: event.callId,
          eventId: event.eventId,
          eventType: event.type,
          occurredAt: new Date(event.occurredAt),
          validatedPayload: event as unknown as Prisma.InputJsonValue,
          claimedAt: now,
          attemptCount: 1,
        },
      });
      return { status: 'claimed' };
    } catch (err) {
      if (!this.isUniqueConstraintError(err)) throw err;
    }

    const existing = await this.readEvent(event);
    if (existing?.decision) {
      return { status: 'replay', decision: existing.decision as unknown as RuntimeUsageDecision };
    }

    const reclaimed = await this.prisma.runtimeUsageEvent.updateMany({
      where: {
        organizationId: event.organizationId,
        eventId: event.eventId,
        processedAt: null,
        OR: [{ claimedAt: null }, { claimedAt: { lte: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
      },
      data: { claimedAt: now, attemptCount: { increment: 1 } },
    });
    if (reclaimed.count === 1) {
      return { status: 'claimed' };
    }

    return this.awaitDecision(event);
  }

  /**
   * Wait briefly for the delivery that holds the claim to finish, so a
   * duplicate delivery answers with the same decision instead of a spurious
   * refusal that would hang up a healthy call.
   */
  private async awaitDecision(event: RuntimeUsageEvent): Promise<EventClaim> {
    for (let attempt = 0; attempt < CONTENDED_POLL_ATTEMPTS; attempt += 1) {
      await this.sleep(CONTENDED_POLL_INTERVAL_MS);
      const row = await this.readEvent(event);
      if (row?.decision) {
        return { status: 'replay', decision: row.decision as unknown as RuntimeUsageDecision };
      }
    }
    return { status: 'contended' };
  }

  private async readEvent(event: RuntimeUsageEvent): Promise<{ decision: unknown } | null> {
    return this.prisma.runtimeUsageEvent.findUnique({
      where: {
        organizationId_eventId: {
          organizationId: event.organizationId,
          eventId: event.eventId,
        },
      },
      select: { decision: true },
    });
  }

  private async releaseClaim(event: RuntimeUsageEvent): Promise<void> {
    try {
      await this.prisma.runtimeUsageEvent.updateMany({
        where: {
          organizationId: event.organizationId,
          eventId: event.eventId,
          processedAt: null,
        },
        data: { claimedAt: null },
      });
    } catch (err) {
      this.logger.error(
        `Failed to release claim on runtime usage event ${event.eventId}: ${(err as Error).message}`,
      );
    }
  }

  private isUniqueConstraintError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async decide(
    event: RuntimeUsageEvent,
    workspaceId: string,
  ): Promise<RuntimeUsageDecision> {
    switch (event.type) {
      case 'call_connected':
        return this.onConnected(event);
      case 'minute_boundary':
        return this.onMinuteBoundary(event, workspaceId);
      case 'call_ended':
        return this.onEnded(event);
      case 'call_failed':
        return this.onFailed(event);
    }
  }

  /**
   * The reserved first minute becomes revenue the moment the call connects.
   * Committing here is what makes an abandoned call refundable and a connected
   * call billed exactly once.
   */
  private async onConnected(
    event: Extract<RuntimeUsageEvent, { type: 'call_connected' }>,
  ): Promise<RuntimeUsageDecision> {
    try {
      const balance = await this.creditLedger.commitReservation({
        organizationId: event.organizationId,
        callId: event.callId,
        idempotencyKey: `call:${event.callId}:reservation_commit`,
      });
      // `connectedAt` is the first-minute marker, not `finalizationState`.
      //
      // A `minute_boundary` can be delivered before `call_connected`; it debits
      // usage but leaves the state `pending`, so keying off the state here would
      // match again and overwrite accumulated seconds with a flat 60. Matching
      // on `connectedAt: null` makes the first-minute write happen exactly once
      // regardless of delivery order, and incrementing preserves any minutes a
      // boundary already debited. `finalized` is excluded so a late connect
      // cannot reopen a settled call.
      await this.prisma.callUsage.updateMany({
        where: {
          callId: event.callId,
          organizationId: event.organizationId,
          connectedAt: null,
          finalizationState: { not: 'finalized' },
        },
        data: {
          connectedAt: new Date(event.occurredAt),
          providerCallId: event.providerCallId,
          billableSeconds: { increment: SECONDS_PER_MINUTE },
          debitedSeconds: { increment: SECONDS_PER_MINUTE },
          finalizationState: 'connected',
        },
      });
      return this.decision(event, true, 'allowed', 1, balance);
    } catch (err) {
      this.logger.error(
        `Commit failed for connected call ${event.callId}: ${(err as Error).message}`,
      );
      const balance = await this.creditLedger.getBalance(event.organizationId);
      return this.decision(event, false, 'billing_temporarily_unavailable', 0, balance);
    }
  }

  /**
   * Each further minute is debited before it is consumed. A denial is the
   * runtime's instruction to hang up, which is what stops an unfunded call from
   * running indefinitely.
   */
  private async onMinuteBoundary(
    event: Extract<RuntimeUsageEvent, { type: 'minute_boundary' }>,
    workspaceId: string,
  ): Promise<RuntimeUsageDecision> {
    try {
      const decision = await this.creditLedger.reserveAndDebitNextMinute({
        organizationId: event.organizationId,
        workspaceId,
        callId: event.callId,
        eventId: event.eventId,
        idempotencyKey: `call:${event.callId}:minute:${event.minute}`,
      });
      if (decision.allowed) {
        await this.prisma.callUsage.updateMany({
          where: { callId: event.callId, organizationId: event.organizationId },
          data: {
            billableSeconds: { increment: SECONDS_PER_MINUTE },
            debitedSeconds: { increment: SECONDS_PER_MINUTE },
          },
        });
      }
      return decision;
    } catch (err) {
      this.logger.error(
        `Minute debit failed for call ${event.callId}: ${(err as Error).message}`,
      );
      const balance = await this.creditLedger.getBalance(event.organizationId);
      return this.decision(event, false, 'billing_temporarily_unavailable', 0, balance);
    }
  }

  /**
   * Settles a call the runtime reports as finished.
   *
   * `connectedAt` decides whether anything is owed, and it must be consulted
   * before the row is finalized. `call_ended` is not conditional on a
   * successful `call_connected`: the meter's shutdown callback fires on any
   * teardown, so an end can arrive for a call whose commit never happened —
   * the commit was refused, the ledger was unreachable for the whole retry
   * budget, or the process died between admission and connection.
   *
   * Finalizing such a call unconditionally strands its reserved minute for
   * good. `finalized` is outside the window `finalizeStaleCalls` sweeps
   * (`pending`/`releasing`), and `reconcileOneBalance` only rebuilds
   * `availableSeconds`, never `reservedSeconds`. So the seconds would be gone
   * from the customer's bucket and counted as reserved forever, with no pass
   * that can recover either. A call that never connected is therefore
   * compensated rather than completed, which returns the minute, frees the
   * concurrency slot, and closes the usage row in one idempotent step.
   */
  private async onEnded(
    event: Extract<RuntimeUsageEvent, { type: 'call_ended' }>,
  ): Promise<RuntimeUsageDecision> {
    const usage = await this.prisma.callUsage.findFirst({
      where: { callId: event.callId, organizationId: event.organizationId },
      select: { connectedAt: true },
    });

    // Written as an explicit null check on a selected column rather than a
    // truthiness test so the meaning survives the non-strict production build.
    if (usage !== null && usage.connectedAt === null) {
      // `compensate` tolerates an already-committed reservation, so a commit
      // that landed between this read and here degrades to a logged skip
      // instead of corrupting the balance.
      await this.admission.compensate(
        event.organizationId,
        event.callId,
        'ended_without_connect',
      );
      // Recorded after compensation, which owns `endedAt` and the finalization
      // state; only the runtime-reported duration is added here.
      await this.prisma.callUsage.updateMany({
        where: { callId: event.callId, organizationId: event.organizationId },
        data: { rawConnectedSeconds: event.durationSeconds },
      });
      const compensatedBalance = await this.creditLedger.getBalance(event.organizationId);
      return this.decision(event, true, 'allowed', 0, compensatedBalance);
    }

    await this.prisma.callUsage.updateMany({
      where: { callId: event.callId, organizationId: event.organizationId },
      data: {
        endedAt: new Date(event.occurredAt),
        rawConnectedSeconds: event.durationSeconds,
        disposition: 'completed',
        finalizationState: 'finalized',
      },
    });
    await this.admission.releaseLease(event.organizationId, event.callId);
    const balance = await this.creditLedger.getBalance(event.organizationId);
    return this.decision(event, true, 'allowed', 0, balance);
  }

  /**
   * A call that never connected owes nothing, so the reserved minute is
   * returned to the customer and the concurrency slot is freed immediately
   * rather than waiting for the lease to expire.
   */
  private async onFailed(
    event: Extract<RuntimeUsageEvent, { type: 'call_failed' }>,
  ): Promise<RuntimeUsageDecision> {
    await this.admission.compensate(event.organizationId, event.callId, `failed:${event.failureCode}`);
    const balance = await this.creditLedger.getBalance(event.organizationId);
    return this.decision(event, true, 'allowed', 0, balance);
  }

  /**
   * A refusal issued without consulting the ledger, for events we will not act
   * on at all. The balance is reported as empty rather than guessed, and the
   * reason is the retryable one so the runtime backs off instead of treating it
   * as a permanent billing failure.
   */
  private denyRetryable(event: RuntimeUsageEvent): RuntimeUsageDecision {
    return {
      eventId: event.eventId,
      callId: event.callId,
      organizationId: event.organizationId,
      allowed: false,
      reason: 'billing_temporarily_unavailable',
      billableMinutes: 0,
      creditBalance: {
        organizationId: event.organizationId,
        includedMinutesRemaining: 0,
        purchasedMinutesRemaining: 0,
      },
    };
  }

  private decision(
    event: RuntimeUsageEvent,
    allowed: boolean,
    reason: RuntimeUsageDecision['reason'],
    billableMinutes: number,
    balance: CreditBalance,
  ): RuntimeUsageDecision {
    return {
      eventId: event.eventId,
      callId: event.callId,
      organizationId: event.organizationId,
      allowed,
      reason,
      billableMinutes,
      creditBalance: {
        organizationId: balance.organizationId,
        includedMinutesRemaining: balance.includedMinutesRemaining,
        purchasedMinutesRemaining: balance.purchasedMinutesRemaining,
      },
    };
  }
}
