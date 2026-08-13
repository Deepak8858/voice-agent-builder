import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RuntimeUsageDecision, RuntimeUsageEvent } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CallAdmissionService } from './call-admission.service';
import { CreditLedgerService, type CreditBalance } from './credit-ledger.service';

const SECONDS_PER_MINUTE = 60;

/**
 * Metering for a live call.
 *
 * The runtime reports what happened; this service decides what it costs and
 * whether the call may continue. Every event is persisted before it is acted
 * on, and a repeated `eventId` returns the original decision rather than
 * charging twice — the runtime retries on network failure, so at-least-once
 * delivery is assumed.
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
      return this.denyUnknown(event);
    }

    const replay = await this.prisma.runtimeUsageEvent.findUnique({
      where: {
        organizationId_eventId: {
          organizationId: event.organizationId,
          eventId: event.eventId,
        },
      },
      select: { decision: true },
    });
    if (replay?.decision) {
      return replay.decision as unknown as RuntimeUsageDecision;
    }

    await this.persistEvent(event);

    const decision = await this.decide(event, call.workspaceId);

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
      await this.prisma.callUsage.updateMany({
        where: { callId: event.callId, organizationId: event.organizationId },
        data: {
          connectedAt: new Date(event.occurredAt),
          providerCallId: event.providerCallId,
          billableSeconds: SECONDS_PER_MINUTE,
          debitedSeconds: SECONDS_PER_MINUTE,
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

  private async onEnded(
    event: Extract<RuntimeUsageEvent, { type: 'call_ended' }>,
  ): Promise<RuntimeUsageDecision> {
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

  private async persistEvent(event: RuntimeUsageEvent): Promise<void> {
    await this.prisma.runtimeUsageEvent.upsert({
      where: {
        organizationId_eventId: {
          organizationId: event.organizationId,
          eventId: event.eventId,
        },
      },
      create: {
        organizationId: event.organizationId,
        callId: event.callId,
        eventId: event.eventId,
        eventType: event.type,
        occurredAt: new Date(event.occurredAt),
        validatedPayload: event as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
  }

  private denyUnknown(event: RuntimeUsageEvent): RuntimeUsageDecision {
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
        lifetimeBrowserTestSecondsRemaining: 0,
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
        lifetimeBrowserTestSecondsRemaining: balance.lifetimeBrowserTestSecondsRemaining,
      },
    };
  }
}
