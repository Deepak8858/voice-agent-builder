import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { BillingService } from '../billing/billing.service';

interface StripeWebhookResult {
  handled: boolean;
  message: string;
  statusCode: 200 | 400 | 500;
}

interface StripeWebhookEvent {
  id: string;
  type: string;
  api_version?: string | null;
  created: number;
  livemode: boolean;
  pending_webhooks: number;
  data: { object: unknown };
}

type StripeEventClaim = 'claimed' | 'processed' | 'processing';

interface StripeSubscriptionItem {
  price?: { id?: string };
  current_period_start?: number;
  current_period_end?: number;
}

/**
 * Converts a Stripe UNIX timestamp (seconds) to a Date, returning null for any
 * value that would produce an `Invalid Date`. Prisma throws
 * `PrismaClientValidationError` on invalid Date objects, which would turn an
 * otherwise-recoverable webhook into a 500 and trigger Stripe retries.
 */
function toDateFromUnixSeconds(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface StripeWebhookClient {
  webhooks: {
    constructEvent(
      payload: Buffer,
      signature: string,
      secret: string,
    ): StripeWebhookEvent;
  };
}

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly stripe: StripeWebhookClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly queueService: QueueService,
  ) {
    this.stripe = env.STRIPE_SECRET_KEY
      ? (new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' }) as unknown as StripeWebhookClient)
      : null;
  }

  async handleWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<StripeWebhookResult> {
    if (!this.stripe || !env.STRIPE_WEBHOOK_SECRET) {
      this.logger.warn('Stripe not configured; skipping webhook.');
      return { handled: false, message: 'Stripe not configured', statusCode: 500 };
    }

    let event: StripeWebhookEvent;
    try {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      this.logger.warn(`Webhook signature verification failed: ${err}`);
      return { handled: false, message: 'Invalid signature', statusCode: 400 };
    }

    try {
      const claim = await this.claimEvent(event);
      if (claim === 'processed') {
        return { handled: true, message: `Event ${event.id} already processed`, statusCode: 200 };
      }
      if (claim === 'processing') {
        return { handled: true, message: `Event ${event.id} already being processed`, statusCode: 200 };
      }
      await this.dispatch(event);
      await this.markProcessed(event);
      return { handled: true, message: `Event ${event.id} processed`, statusCode: 200 };
    } catch (err) {
      await this.markError(event, String(err));
      return { handled: false, message: String(err), statusCode: 500 };
    }
  }

  private async markProcessed(event: StripeWebhookEvent): Promise<void> {
    await this.prisma.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date(), errorMessage: null },
    });
  }

  private async claimEvent(event: StripeWebhookEvent): Promise<StripeEventClaim> {
    try {
      await this.prisma.stripeEvent.create({
        data: this.stripeEventData(event),
      });
      return 'claimed';
    } catch (err) {
      if (!this.isUniqueConstraintError(err)) throw err;
    }

    const existing = await this.prisma.stripeEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (existing?.processedAt) return 'processed';
    if (!existing?.errorMessage) return 'processing';

    const claimed = await this.prisma.stripeEvent.updateMany({
      where: {
        stripeEventId: event.id,
        processedAt: null,
        errorMessage: { not: null },
      },
      data: { errorMessage: null },
    });
    return claimed.count === 1 ? 'claimed' : 'processing';
  }

  private stripeEventData(event: StripeWebhookEvent): Prisma.StripeEventCreateInput {
    return {
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version ?? null,
      created: this.eventCreatedAt(event),
      data: event.data.object as unknown as Prisma.InputJsonValue,
      livemode: event.livemode,
      pendingWebhooks: event.pending_webhooks,
    };
  }

  /**
   * `StripeEvent.created` is non-nullable, so fall back to the receive time when
   * Stripe omits or malforms the timestamp rather than letting Prisma reject the
   * row and lose our idempotency record for the event entirely.
   */
  private eventCreatedAt(event: StripeWebhookEvent): Date {
    return toDateFromUnixSeconds(event.created) ?? new Date();
  }

  private isUniqueConstraintError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
  }

  private async markError(event: StripeWebhookEvent, errorMessage: string): Promise<void> {
    await this.prisma.stripeEvent.upsert({
      where: { stripeEventId: event.id },
      create: {
        stripeEventId: event.id,
        type: event.type,
        apiVersion: event.api_version ?? null,
        created: this.eventCreatedAt(event),
        data: event.data.object as unknown as Prisma.InputJsonValue,
        livemode: event.livemode,
        pendingWebhooks: event.pending_webhooks,
        errorMessage,
      },
      update: { errorMessage },
    });
  }

  private async dispatch(event: StripeWebhookEvent): Promise<void> {
    const data = event.data.object as unknown as Record<string, unknown>;
    const orgId = (data['metadata'] as Record<string, string> | undefined)?.organizationId;

    switch (event.type) {
      case 'checkout.session.completed': {
        const customerId = data['customer'] as string;
        if (orgId && customerId) {
          await this.handleCheckoutCompleted(orgId, customerId, data);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subId = data['id'] as string;
        const customerId = data['customer'] as string;
        if (subId && customerId) {
          await this.handleSubscriptionUpdated(subId, customerId, data);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subId = data['id'] as string;
        if (subId) {
          await this.handleSubscriptionDeleted(subId);
        }
        break;
      }
      case 'invoice.paid': {
        const customerId = data['customer'] as string;
        if (customerId) {
          await this.handleInvoicePaid(customerId);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const customerId = data['customer'] as string;
        if (customerId) {
          await this.handleInvoicePaymentFailed(customerId);
        }
        break;
      }
      default:
        this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  private async handleCheckoutCompleted(
    orgId: string,
    customerId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.logger.log(`Checkout completed for org ${orgId}, customer ${customerId}`);
    const subscriptionId = typeof data['subscription'] === 'string'
      ? data['subscription']
      : null;
    await this.prisma.subscription.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        plan: 'free',
        status: 'incomplete',
      },
      update: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId ?? undefined,
      },
    });
    await this.logBillingAudit(orgId, 'billing.subscription_synced', {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      status: 'incomplete',
    });
  }

  private async handleSubscriptionUpdated(
    _stripeSubId: string,
    customerId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const status = data['status'] as string;
    const priceId = this.extractPriceId(data);
    const plan = this.inferPlanFromPriceId(priceId);
    const { periodStart, periodEnd } = this.extractBillingPeriod(data);
    const cancelAtPeriodEnd = data['cancel_at_period_end'] as boolean;
    const trialEnd = toDateFromUnixSeconds(data['trial_end']);

    await this.prisma.subscription.updateMany({
      where: { stripeCustomerId: customerId },
      data: {
        stripeSubscriptionId: data['id'] as string,
        stripePriceId: priceId,
        status: status ?? 'active',
        plan,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: cancelAtPeriodEnd ?? false,
        trialEnd,
      },
    });
    await this.logBillingAuditForCustomer(customerId, 'billing.subscription_synced', {
      stripeSubscriptionId: data['id'],
      stripePriceId: priceId,
      plan,
      status,
    });
  }

  private async handleSubscriptionDeleted(stripeSubId: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { stripeSubscriptionId: stripeSubId },
      data: { status: 'canceled' },
    });
    await this.logBillingAuditForSubscription(stripeSubId, 'billing.subscription_synced', {
      stripeSubscriptionId: stripeSubId,
      status: 'canceled',
    });
  }

  private async handleInvoicePaid(customerId: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { stripeCustomerId: customerId },
      data: { status: 'active' },
    });
    await this.logBillingAuditForCustomer(customerId, 'billing.subscription_synced', {
      stripeCustomerId: customerId,
      status: 'active',
    });
  }

  private async handleInvoicePaymentFailed(customerId: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { stripeCustomerId: customerId },
      data: { status: 'past_due' },
    });
    await this.logBillingAuditForCustomer(customerId, 'billing.payment_failed', {
      stripeCustomerId: customerId,
      status: 'past_due',
    });
    // Queue dunning email notification (best-effort)
    try {
      const sub = await this.prisma.subscription.findFirst({
        where: { stripeCustomerId: customerId },
        include: { organization: { select: { id: true, name: true } } },
      });
      if (sub?.organization) {
        await this.queueService.enqueue('notifications', 'dunning_email', {
          organizationId: sub.organization.id,
          organizationName: sub.organization.name,
          customerId,
        });
        this.logger.log(`Dunning email queued for org ${sub.organization.id}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to queue dunning email: ${err}`);
    }
  }

  private extractPriceId(data: Record<string, unknown>): string | null {
    return this.extractItems(data)[0]?.price?.id ?? null;
  }

  private extractItems(data: Record<string, unknown>): StripeSubscriptionItem[] {
    const items = (data['items'] as { data?: StripeSubscriptionItem[] } | undefined)?.data;
    return Array.isArray(items) ? items : [];
  }

  /**
   * Resolves the subscription's billing period.
   *
   * Stripe removed the top-level `current_period_start`/`current_period_end`
   * fields from the Subscription object in API version `2025-03-31.basil` and
   * moved them onto each SubscriptionItem, so a subscription can now carry
   * items with differing billing cycles. We therefore span the widest window
   * across all items (earliest start, latest end), which matches the legacy
   * top-level semantics for the common single-item case.
   *
   * The top-level fields are still read as a fallback so that events delivered
   * by webhook endpoints pinned to a pre-Basil API version keep working.
   */
  private extractBillingPeriod(data: Record<string, unknown>): {
    periodStart: Date | null;
    periodEnd: Date | null;
  } {
    const items = this.extractItems(data);
    const starts = items
      .map((item) => toDateFromUnixSeconds(item?.current_period_start))
      .filter((date): date is Date => date !== null);
    const ends = items
      .map((item) => toDateFromUnixSeconds(item?.current_period_end))
      .filter((date): date is Date => date !== null);

    const periodStart = starts.length
      ? new Date(Math.min(...starts.map((date) => date.getTime())))
      : toDateFromUnixSeconds(data['current_period_start']);
    const periodEnd = ends.length
      ? new Date(Math.max(...ends.map((date) => date.getTime())))
      : toDateFromUnixSeconds(data['current_period_end']);

    if (!periodStart || !periodEnd) {
      this.logger.warn(
        `Subscription ${String(data['id'])} is missing a billing period; ` +
          `persisting null (items=${items.length}).`,
      );
    }

    return { periodStart, periodEnd };
  }

  private inferPlanFromPriceId(priceId: string | null): string {
    if (priceId === env.STRIPE_STARTER_PRICE_ID) return 'starter';
    if (priceId === env.STRIPE_GROWTH_PRICE_ID) return 'growth';
    if (priceId === env.STRIPE_ENTERPRISE_PRICE_ID) return 'enterprise';
    return 'free';
  }

  private async logBillingAuditForCustomer(
    stripeCustomerId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const sub = await this.prisma.subscription.findFirst({
      where: { stripeCustomerId },
      select: { organizationId: true },
    });
    if (!sub) return;
    await this.logBillingAudit(sub.organizationId, action, metadata);
  }

  private async logBillingAuditForSubscription(
    stripeSubscriptionId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const sub = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId },
      select: { organizationId: true },
    });
    if (!sub) return;
    await this.logBillingAudit(sub.organizationId, action, metadata);
  }

  private async logBillingAudit(
    organizationId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        action,
        resourceType: 'subscription',
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
