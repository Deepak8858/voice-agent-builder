import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import type { PlanType } from '@voiceforge/shared';
import { BILLING_CATALOG_VERSION, getPlanEntitlements } from '@voiceforge/shared';
import { CacheInvalidator } from '../common/cache-invalidator';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { BillingService } from '../billing/billing.service';
import { CreditLedgerService } from '../billing/credit-ledger.service';

interface StripeWebhookResult {
  handled: boolean;
  message: string;
  statusCode: 200 | 400 | 500;
}

/**
 * How long a claimed-but-unfinished event is considered owned by the process
 * that claimed it. After this, a crashed handler's claim is reclaimable so the
 * event is not stranded unprocessed forever.
 */
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

const PACK_GRANT_ACTION = 'billing.pack_credit_granted';

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

interface StripeInvoiceLine {
  price?: { id?: string } | null;
  pricing?: { price_details?: { price?: string } } | null;
  period?: { start?: number; end?: number } | null;
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
    private readonly creditLedger: CreditLedgerService,
    private readonly cacheInvalidator?: CacheInvalidator,
  ) {
    this.stripe = env.STRIPE_SECRET_KEY
      ? (new Stripe(env.STRIPE_SECRET_KEY, {
          apiVersion: Stripe.API_VERSION,
          maxNetworkRetries: 2,
        }) as unknown as StripeWebhookClient)
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
      data: { processedAt: new Date(), processingStartedAt: null, errorMessage: null },
    });
  }

  /**
   * Ownership is decided by an explicit processing lease rather than by
   * inferring it from `errorMessage`. A handler that crashes mid-dispatch never
   * gets the chance to record an error, so an error-based heuristic would leave
   * the event claimed forever and silently drop a paid grant. A claim older than
   * {@link PROCESSING_LEASE_MS} is therefore reclaimable, and the reclaim bumps
   * `attemptCount` so repeated failures are visible.
   */
  private async claimEvent(event: StripeWebhookEvent): Promise<StripeEventClaim> {
    const now = new Date();
    try {
      await this.prisma.stripeEvent.create({
        data: this.stripeEventData(event, now),
      });
      return 'claimed';
    } catch (err) {
      if (!this.isUniqueConstraintError(err)) throw err;
    }

    const existing = await this.prisma.stripeEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (existing?.processedAt) return 'processed';

    const leaseExpiry = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const reclaimed = await this.prisma.stripeEvent.updateMany({
      where: {
        stripeEventId: event.id,
        processedAt: null,
        OR: [
          { processingStartedAt: null },
          { processingStartedAt: { lte: leaseExpiry } },
        ],
      },
      data: {
        processingStartedAt: now,
        attemptCount: { increment: 1 },
        errorMessage: null,
      },
    });
    return reclaimed.count === 1 ? 'claimed' : 'processing';
  }

  private stripeEventData(
    event: StripeWebhookEvent,
    claimedAt: Date,
  ): Prisma.StripeEventCreateInput {
    return {
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version ?? null,
      created: this.eventCreatedAt(event),
      data: event.data.object as unknown as Prisma.InputJsonValue,
      livemode: event.livemode,
      pendingWebhooks: event.pending_webhooks,
      processingStartedAt: claimedAt,
      attemptCount: 1,
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
      update: { errorMessage, processingStartedAt: null },
    });
  }

  private async dispatch(event: StripeWebhookEvent): Promise<void> {
    const data = event.data.object as unknown as Record<string, unknown>;
    const orgId = (data['metadata'] as Record<string, string> | undefined)?.organizationId;

    switch (event.type) {
      case 'checkout.session.completed': {
        const customerId = data['customer'] as string;
        if (orgId && customerId) {
          await this.handleCheckoutCompleted(orgId, customerId, data, this.eventCreatedAt(event));
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
          await this.handleInvoicePaid(customerId, data);
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
      case 'charge.refunded':
      case 'charge.dispute.closed': {
        await this.handleChargeReversal(event.type, data);
        break;
      }
      default:
        this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  /**
   * Checkout completion never grants subscription credit — that is driven by
   * `invoice.paid`, which is the only event that proves money was collected for
   * a billing period. A completed one-time pack Checkout does grant, because
   * there is no invoice behind it.
   */
  private async handleCheckoutCompleted(
    orgId: string,
    customerId: string,
    data: Record<string, unknown>,
    eventCreatedAt: Date,
  ): Promise<void> {
    const metadata = (data['metadata'] as Record<string, string> | undefined) ?? {};
    if (metadata['purchaseType'] === 'minute_pack') {
      await this.handleMinutePackPurchase(orgId, customerId, data, eventCreatedAt);
      return;
    }

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
    await this.invalidateSubscriptionCache(orgId);
  }

  /**
   * Grants the prepaid pack only when Stripe reports the money as collected and
   * the organization named in metadata actually owns the Stripe customer that
   * paid. Metadata is client-influenced at Checkout creation time, so trusting
   * it alone would let one organization fund another's balance.
   */
  private async handleMinutePackPurchase(
    orgId: string,
    customerId: string,
    data: Record<string, unknown>,
    purchasedAt: Date,
  ): Promise<void> {
    if (data['payment_status'] !== 'paid') {
      this.logger.warn(
        `Ignoring unpaid minute-pack checkout ${String(data['id'])} for org ${orgId}`,
      );
      return;
    }

    const owner = await this.prisma.subscription.findFirst({
      where: { organizationId: orgId, stripeCustomerId: customerId },
      select: { organizationId: true },
    });
    if (!owner) {
      this.logger.error(
        `Minute-pack checkout ${String(data['id'])} claims org ${orgId} but customer ` +
          `${customerId} is not owned by it; refusing to grant credit`,
      );
      return;
    }

    const checkoutSessionId = String(data['id']);
    await this.creditLedger.grantPurchasedCredits({
      organizationId: orgId,
      checkoutSessionId,
      // Stripe's immutable event timestamp keeps retries byte-for-byte
      // idempotent and prevents a delayed delivery from extending expiry.
      purchasedAt,
    });
    await this.logBillingAudit(orgId, PACK_GRANT_ACTION, {
      checkoutSessionId,
      stripeCustomerId: customerId,
      paymentIntentId: typeof data['payment_intent'] === 'string' ? data['payment_intent'] : null,
      catalogVersion: BILLING_CATALOG_VERSION,
    });
  }

  private async handleSubscriptionUpdated(
    stripeSubId: string,
    customerId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const status = data['status'] as string;
    const priceId = this.extractPriceId(data);
    const plan = this.inferPlanFromPriceId(priceId);
    const { periodStart, periodEnd } = this.extractBillingPeriod(data);
    const cancelAtPeriodEnd = data['cancel_at_period_end'] as boolean;
    const trialEnd = toDateFromUnixSeconds(data['trial_end']);

    const subscription = await this.resolveSubscription(customerId, stripeSubId);
    await this.prisma.subscription.update({
      where: { organizationId: subscription.organizationId },
      data: {
        stripeSubscriptionId: data['id'] as string,
        stripePriceId: priceId,
        status: status ?? 'active',
        plan,
        catalogVersion: BILLING_CATALOG_VERSION,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: cancelAtPeriodEnd ?? false,
        trialEnd,
        webhookUpdatedAt: new Date(),
      },
    });
    await this.logBillingAudit(subscription.organizationId, 'billing.subscription_synced', {
      stripeSubscriptionId: data['id'],
      stripePriceId: priceId,
      plan,
      status,
    });
    await this.invalidateSubscriptionCache(subscription.organizationId);
  }

  private async handleSubscriptionDeleted(stripeSubId: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { stripeSubscriptionId: stripeSubId },
      data: { status: 'canceled', webhookUpdatedAt: new Date() },
    });
    await this.logBillingAuditForSubscription(stripeSubId, 'billing.subscription_synced', {
      stripeSubscriptionId: stripeSubId,
      status: 'canceled',
    });
    const sub = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSubId },
      select: { organizationId: true },
    });
    if (sub) await this.invalidateSubscriptionCache(sub.organizationId);
  }

  /**
   * A paid invoice is the only proof that a billing period was funded, so it is
   * where included minutes are granted. The plan comes from the server-owned
   * price map on the invoice line rather than from any client-supplied value,
   * and the grant is keyed by invoice ID so a redelivered event cannot grant
   * twice.
   */
  private async handleInvoicePaid(
    customerId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const invoicePriceId = this.extractInvoicePriceId(data);
    const plan = this.inferPlanFromPriceId(invoicePriceId);
    if (!invoicePriceId || plan === 'free') {
      throw new Error(`Invoice ${String(data['id'])} uses an unrecognized Stripe price`);
    }
    const periodEnd = this.extractInvoicePeriodEnd(data);
    const stripeSubscriptionId = typeof data['subscription'] === 'string' ? data['subscription'] : null;
    const sub = await this.resolveSubscription(customerId, stripeSubscriptionId);

    await this.prisma.subscription.update({
      where: { organizationId: sub.organizationId },
      data: {
        status: 'active',
        plan,
        stripePriceId: invoicePriceId,
        catalogVersion: BILLING_CATALOG_VERSION,
        ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        webhookUpdatedAt: new Date(),
      },
    });
    await this.logBillingAudit(sub.organizationId, 'billing.subscription_synced', {
      stripeCustomerId: customerId,
      status: 'active',
      plan,
    });
    const invoiceId = typeof data['id'] === 'string' ? data['id'] : null;
    const includedMinutes = getPlanEntitlements(plan).includedMinutes;
    if (invoiceId && periodEnd && includedMinutes > 0) {
      await this.creditLedger.grantSubscriptionCredits({
        organizationId: sub.organizationId,
        invoiceId,
        includedMinutes,
        periodEnd,
      });
      await this.logBillingAudit(sub.organizationId, 'billing.included_credit_granted', {
        invoiceId,
        plan,
        includedMinutes,
        periodEnd: periodEnd.toISOString(),
        catalogVersion: BILLING_CATALOG_VERSION,
      });
    }

    await this.invalidateSubscriptionCache(sub.organizationId);
  }

  /**
   * A refund or a lost dispute removes the credit the payment bought. The
   * ledger decides whether the unused remainder can simply be withdrawn or
   * whether consumed credit forces manual review; this handler only maps the
   * Stripe charge back to the pack Checkout that granted it.
   */
  private async handleChargeReversal(
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (eventType === 'charge.dispute.closed' && data['status'] !== 'lost') {
      this.logger.log(`Dispute ${String(data['id'])} closed as ${String(data['status'])}; no reversal`);
      return;
    }

    const paymentIntentId =
      typeof data['payment_intent'] === 'string' ? data['payment_intent'] : null;
    if (!paymentIntentId) {
      this.logger.warn(`${eventType} without a payment intent; cannot map to a credit grant`);
      return;
    }

    // Dispute payloads do not contain a customer. The server-authored grant is
    // the durable mapping from Stripe's payment intent to our organization.
    const grants = await this.prisma.auditLog.findMany({
      where: {
        action: PACK_GRANT_ACTION,
        metadata: { path: ['paymentIntentId'], equals: paymentIntentId },
      },
      distinct: ['organizationId'],
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { organizationId: true, metadata: true },
    });
    if (grants.length !== 1 || !grants[0]) {
      throw new Error(
        `${eventType} for payment intent ${paymentIntentId} did not resolve to exactly one organization`,
      );
    }
    const grant = grants[0];
    const organizationId = grant.organizationId;
    if (!organizationId) {
      throw new Error(
        `${eventType} for payment intent ${paymentIntentId} has no organization owner`,
      );
    }
    const metadata = (grant.metadata ?? null) as { checkoutSessionId?: unknown } | null;
    const checkoutSessionId =
      typeof metadata?.checkoutSessionId === 'string' ? metadata.checkoutSessionId : null;
    if (!checkoutSessionId) {
      throw new Error(
        `${eventType} for payment intent ${paymentIntentId} has no recorded minute-pack grant`,
      );
    }

    const refundId = typeof data['id'] === 'string' ? data['id'] : null;
    if (!refundId) throw new Error(`${eventType} for ${paymentIntentId} has no reversal id`);

    const amount = typeof data['amount'] === 'number' ? data['amount'] : null;
    const amountRefunded = typeof data['amount_refunded'] === 'number' ? data['amount_refunded'] : amount;
    if (amount && amountRefunded !== amount) {
      await this.logBillingAudit(organizationId, 'billing.pack_partial_refund_review', {
        eventType,
        checkoutSessionId,
        refundId,
        paymentIntentId,
        amount,
        amountRefunded,
      });
      this.logger.warn(`Partial refund ${refundId} recorded for manual review`);
      return;
    }

    await this.creditLedger.reversePurchasedCredits({
      organizationId,
      checkoutSessionId,
      refundId,
    });
    await this.logBillingAudit(organizationId, 'billing.pack_credit_reversed', {
      eventType,
      checkoutSessionId,
      refundId,
      paymentIntentId,
    });
  }

  private async invalidateSubscriptionCacheForCustomer(customerId: string): Promise<void> {
    const sub = await this.prisma.subscription.findFirst({
      where: { stripeCustomerId: customerId },
      select: { organizationId: true },
    });
    if (sub) await this.invalidateSubscriptionCache(sub.organizationId);
  }

  /**
   * Subscription reads are cached for a minute. Without this, a customer who
   * just paid keeps seeing their old plan (and old limits) until the TTL
   * expires.
   */
  private async invalidateSubscriptionCache(organizationId: string): Promise<void> {
    await this.cacheInvalidator?.invalidateBillingSubscription(organizationId);
  }

  private async handleInvoicePaymentFailed(customerId: string): Promise<void> {
    const resolved = await this.resolveSubscription(customerId, null);
    await this.prisma.subscription.update({
      where: { organizationId: resolved.organizationId },
      data: { status: 'past_due' },
    });
    await this.logBillingAudit(resolved.organizationId, 'billing.payment_failed', {
      stripeCustomerId: customerId,
      status: 'past_due',
    });
    // Queue dunning email notification (best-effort)
    try {
      const sub = await this.prisma.subscription.findUnique({
        where: { organizationId: resolved.organizationId },
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

  /**
   * Only server-owned Price IDs may name a plan. Anything else resolves to Free
   * so a price created outside our configuration cannot grant paid entitlements.
   */
  private inferPlanFromPriceId(priceId: string | null): PlanType {
    if (priceId && priceId === env.STRIPE_STARTER_PRICE_ID) return 'starter';
    if (priceId && priceId === env.STRIPE_GROWTH_PRICE_ID) return 'growth';
    if (priceId && priceId === env.STRIPE_ENTERPRISE_PRICE_ID) return 'enterprise';
    return 'free';
  }

  private extractInvoiceLines(data: Record<string, unknown>): StripeInvoiceLine[] {
    const lines = (data['lines'] as { data?: StripeInvoiceLine[] } | undefined)?.data;
    return Array.isArray(lines) ? lines : [];
  }

  private extractInvoicePriceId(data: Record<string, unknown>): string | null {
    for (const line of this.extractInvoiceLines(data)) {
      const priceId = line.price?.id ?? line.pricing?.price_details?.price ?? null;
      if (priceId) return priceId;
    }
    return null;
  }

  /**
   * Included credit expires at the end of the period it was billed for, so the
   * grant needs that boundary. Newer API versions moved the period onto the
   * invoice line, and the top-level field is read as a fallback for endpoints
   * pinned to older versions.
   */
  private extractInvoicePeriodEnd(data: Record<string, unknown>): Date | null {
    const ends = this.extractInvoiceLines(data)
      .map((line) => toDateFromUnixSeconds(line.period?.end))
      .filter((date): date is Date => date !== null);
    if (ends.length) {
      return new Date(Math.max(...ends.map((date) => date.getTime())));
    }
    return toDateFromUnixSeconds(data['period_end']);
  }

  private async resolveSubscription(
    stripeCustomerId: string,
    stripeSubscriptionId: string | null,
  ): Promise<{ organizationId: string }> {
    const matches = await this.prisma.subscription.findMany({
      where: {
        stripeCustomerId,
        ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
      },
      select: { organizationId: true },
      take: 2,
    });
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(
        `Stripe customer ${stripeCustomerId} did not resolve to exactly one organization`,
      );
    }
    return matches[0];
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
