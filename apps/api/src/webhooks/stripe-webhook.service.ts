import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
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

/**
 * The only currency this deployment prices in: the shared catalog quotes the
 * minute pack in `priceUsd` and every plan Price is created in USD. A payment in
 * anything else is either a misconfigured Stripe Price or a Price belonging to
 * someone else's account, and its amount cannot be compared to our catalog.
 */
const EXPECTED_CURRENCY = 'usd';

/**
 * How long an event may sit claimed-but-unfinished before the reaper re-drives
 * it. Deliberately far longer than {@link PROCESSING_LEASE_MS} and than any
 * plausible handler: a sweep that raced a live handler would re-run a grant
 * concurrently with itself, and the whole point of the reaper is to be the last
 * resort, not a second scheduler.
 */
const STUCK_EVENT_RECLAIM_MS = 60 * 60 * 1000;

/** Bounded batch, so one sweep cannot monopolise a replica. */
const STUCK_EVENT_SWEEP_LIMIT = 25;

const STUCK_EVENT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

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
export class StripeWebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly stripe: StripeWebhookClient | null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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
      // A 5xx, never a 2xx. `processing` means some delivery holds the lease and
      // has NOT finished — if that delivery is the one that crashed, a 200 here
      // is Stripe's cue to stop redelivering, and the event is then lost for
      // good: the lease expires with nothing left to reclaim it. Failing keeps
      // the event inside Stripe's retry window until a delivery actually
      // completes, and a duplicate delivery of work that does complete costs
      // nothing because the second attempt sees `processed`.
      if (claim === 'processing') {
        return {
          handled: false,
          message: `Event ${event.id} is already being processed`,
          statusCode: 500,
        };
      }
      await this.dispatch(event);
      await this.markProcessed(event);
      return { handled: true, message: `Event ${event.id} processed`, statusCode: 200 };
    } catch (err) {
      await this.markError(event, String(err));
      return { handled: false, message: String(err), statusCode: 500 };
    }
  }

  /**
   * Starts the stuck-event sweep. Registered here rather than as a
   * `billing-reconciliation` job because the reaper needs no Redis and no
   * worker replica: the same process that owns webhook delivery owns recovering
   * the deliveries it dropped.
   */
  onModuleInit(): void {
    if (!this.stripe || !env.STRIPE_WEBHOOK_SECRET) return;
    this.sweepTimer = setInterval(() => {
      void this.reclaimStuckEvents().catch((err: Error) =>
        this.logger.error(`Stuck Stripe event sweep failed: ${err.message}`),
      );
    }, STUCK_EVENT_SWEEP_INTERVAL_MS);
    // Never hold process exit open for a repair job.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Re-drives events left claimed-but-unfinished by a process that died.
   *
   * {@link claimEvent}'s lease already lets the *next delivery* reclaim such a
   * row — but Stripe only redelivers for a bounded window, and once that closes
   * nothing ever arrives to trigger the reclaim. The row then sits `processing`
   * forever, which for `invoice.paid` or a pack Checkout means a customer paid
   * and never received credit, with no error recorded anywhere because the
   * handler never got to record one.
   *
   * The stored payload is the verified one this endpoint accepted, so it is
   * re-dispatched directly; every handler is idempotent by Stripe object id, so
   * a row that turns out to have completed its work simply converges. Claiming
   * through {@link claimEvent} means two replicas sweeping at once cannot both
   * take the same row.
   */
  async reclaimStuckEvents(limit = STUCK_EVENT_SWEEP_LIMIT): Promise<number> {
    const cutoff = new Date(Date.now() - STUCK_EVENT_RECLAIM_MS);
    const stuck = await this.prisma.stripeEvent.findMany({
      where: { processedAt: null, processingStartedAt: { lte: cutoff } },
      orderBy: { processingStartedAt: 'asc' },
      take: limit,
    });

    let recovered = 0;
    for (const row of stuck) {
      const event: StripeWebhookEvent = {
        id: row.stripeEventId,
        type: row.type,
        api_version: row.apiVersion,
        created: Math.floor(row.created.getTime() / 1000),
        livemode: row.livemode,
        pending_webhooks: row.pendingWebhooks,
        data: { object: row.data },
      };
      // Anything but `claimed` means another sweep or a live delivery owns it.
      if ((await this.claimEvent(event)) !== 'claimed') continue;
      this.logger.warn(
        `Re-driving Stripe event ${row.stripeEventId} (${row.type}) stranded in processing ` +
          `since ${row.processingStartedAt?.toISOString() ?? 'unknown'}`,
      );
      try {
        await this.dispatch(event);
        await this.markProcessed(event);
        recovered += 1;
      } catch (err) {
        await this.markError(event, `stuck-event sweep: ${String(err)}`);
        this.logger.error(`Re-driving Stripe event ${row.stripeEventId} failed: ${String(err)}`);
      }
    }
    return recovered;
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
    const eventCreatedAt = this.eventCreatedAt(event);

    switch (event.type) {
      case 'checkout.session.completed': {
        const customerId = data['customer'] as string;
        if (orgId && customerId) {
          await this.handleCheckoutCompleted(orgId, customerId, data, eventCreatedAt, event.id);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subId = data['id'] as string;
        const customerId = data['customer'] as string;
        if (subId && customerId) {
          await this.handleSubscriptionUpdated(subId, customerId, data, eventCreatedAt);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subId = data['id'] as string;
        if (subId) {
          await this.handleSubscriptionDeleted(subId, eventCreatedAt);
        }
        break;
      }
      case 'invoice.paid': {
        const customerId = data['customer'] as string;
        if (customerId) {
          await this.handleInvoicePaid(customerId, data, eventCreatedAt, event.id);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const customerId = data['customer'] as string;
        if (customerId) {
          await this.handleInvoicePaymentFailed(customerId, eventCreatedAt);
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
    stripeEventId: string,
  ): Promise<void> {
    const metadata = (data['metadata'] as Record<string, string> | undefined) ?? {};
    if (metadata['purchaseType'] === 'minute_pack') {
      await this.handleMinutePackPurchase(orgId, customerId, data, eventCreatedAt, stripeEventId);
      return;
    }

    this.logger.log(`Checkout completed for org ${orgId}, customer ${customerId}`);
    const subscriptionId = typeof data['subscription'] === 'string'
      ? data['subscription']
      : null;

    // Relinking an organization that is already linked to a *different* Stripe
    // object silently orphans the old one: Stripe keeps billing the previous
    // subscription while `resolveSubscription` can no longer find it, so its
    // renewals stop granting credit and no refund is ever issued. The
    // organization here comes from Checkout metadata, which is client-influenced
    // (see handleMinutePackPurchase), so an overwrite is refused and reported
    // rather than applied. First-time links, where the stored value is null, are
    // the normal path and are unaffected.
    const conflict = await this.findSubscriptionLinkConflict(orgId, customerId, subscriptionId);
    if (conflict) {
      this.logger.error(
        `Checkout ${String(data['id'])} would relink org ${orgId} ${conflict.field} from ` +
          `${conflict.current} to ${conflict.incoming}; refusing to overwrite the existing link`,
      );
      await this.logBillingAudit(orgId, 'billing.subscription_link_conflict', {
        checkoutSessionId: typeof data['id'] === 'string' ? data['id'] : null,
        field: conflict.field,
        current: conflict.current,
        incoming: conflict.incoming,
      });
      return;
    }

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
   * Reports the first Stripe identifier on the organization's subscription row
   * that a checkout would change to a different non-null value, or null when the
   * link is new or unchanged.
   */
  private async findSubscriptionLinkConflict(
    orgId: string,
    customerId: string,
    subscriptionId: string | null,
  ): Promise<{ field: string; current: string; incoming: string } | null> {
    // A null `stripeCustomerId` on our row is not evidence that the incoming
    // customer is unclaimed. The organization here comes from Checkout metadata,
    // so a session naming an organization that has never had a customer id used
    // to fall straight through this function and have the *paying* customer's id
    // written onto that organization's row — the payer's future invoices then
    // granted credit to someone else's balance. Ownership is checked the same way
    // `handleMinutePackPurchase` checks it, before any link is written.
    const foreignOwner = await this.prisma.subscription.findFirst({
      where: { stripeCustomerId: customerId, organizationId: { not: orgId } },
      select: { organizationId: true },
    });
    if (foreignOwner && foreignOwner.organizationId !== orgId) {
      return {
        field: 'stripeCustomerId',
        current: `held by organization ${foreignOwner.organizationId}`,
        incoming: customerId,
      };
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: { stripeCustomerId: true, stripeSubscriptionId: true },
    });
    if (!existing) return null;
    if (existing.stripeCustomerId && existing.stripeCustomerId !== customerId) {
      return {
        field: 'stripeCustomerId',
        current: existing.stripeCustomerId,
        incoming: customerId,
      };
    }
    if (
      subscriptionId &&
      existing.stripeSubscriptionId &&
      existing.stripeSubscriptionId !== subscriptionId
    ) {
      return {
        field: 'stripeSubscriptionId',
        current: existing.stripeSubscriptionId,
        incoming: subscriptionId,
      };
    }
    return null;
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
    stripeEventId: string,
  ): Promise<void> {
    if (data['payment_status'] !== 'paid') {
      // `unpaid` means a delayed-notification method (ACH/SEPA/Bacs) is still
      // clearing. Nothing here grants it later — the credit would arrive on
      // `checkout.session.async_payment_succeeded`, which we deliberately do not
      // subscribe to — so the pack Checkout is pinned to card in
      // `createTopUpCheckoutSession`. A session created before that pin, or one
      // opened outside the app, therefore means a customer may have paid and
      // received nothing: record it for manual resolution instead of dropping it
      // to a warn line nobody reads.
      if (data['payment_status'] === 'unpaid') {
        this.logger.error(
          `Minute-pack checkout ${String(data['id'])} for org ${orgId} completed unpaid; ` +
            `credit will never be granted automatically`,
        );
        await this.logBillingAudit(orgId, 'billing.pack_checkout_unpaid_review', {
          checkoutSessionId: typeof data['id'] === 'string' ? data['id'] : null,
          stripeCustomerId: customerId,
          paymentIntentId:
            typeof data['payment_intent'] === 'string' ? data['payment_intent'] : null,
        });
        return;
      }
      this.logger.warn(
        `Ignoring minute-pack checkout ${String(data['id'])} for org ${orgId} with ` +
          `payment_status ${String(data['payment_status'])}`,
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
    const paymentIntentId =
      typeof data['payment_intent'] === 'string' ? data['payment_intent'] : null;
    if (
      !(await this.assertMoneyCollected(orgId, 'pack_checkout', checkoutSessionId, {
        amount: data['amount_total'],
        currency: data['currency'],
        paymentIntentId,
      }))
    ) {
      return;
    }

    await this.creditLedger.grantPurchasedCredits({
      organizationId: orgId,
      checkoutSessionId,
      // Stripe's immutable event timestamp keeps retries byte-for-byte
      // idempotent and prevents a delayed delivery from extending expiry.
      purchasedAt,
      ...(paymentIntentId ? { paymentIntentId } : {}),
      // Acknowledging the event is part of the grant's own transaction, so a
      // crash cannot leave money granted and the event looking undelivered.
      stripeEventId,
    });
    await this.logBillingAudit(orgId, PACK_GRANT_ACTION, {
      checkoutSessionId,
      stripeCustomerId: customerId,
      paymentIntentId,
      catalogVersion: BILLING_CATALOG_VERSION,
    });
  }

  /**
   * Refuses to grant credit for a payment that collected no money, or collected
   * it in a currency this deployment does not price in.
   *
   * `payment_status: 'paid'` and `invoice.paid` both hold for a 100%-discounted
   * charge, so neither is evidence of revenue. Nothing in the repo creates
   * coupons today, which is the only reason this has not already leaked — one
   * promotion code created in the Stripe dashboard removes that accidental
   * protection. A mismatch is a manual-review row rather than a throw: the event
   * is not going to succeed on retry, so failing it forever would only bury the
   * signal under a permanently red webhook.
   *
   * Returns true when the grant may proceed.
   */
  private async assertMoneyCollected(
    orgId: string,
    kind: 'pack_checkout' | 'invoice',
    sourceId: string,
    money: { amount: unknown; currency: unknown; paymentIntentId?: string | null },
  ): Promise<boolean> {
    const amount = typeof money.amount === 'number' ? money.amount : null;
    const currency = typeof money.currency === 'string' ? money.currency.toLowerCase() : null;
    if (amount !== null && amount > 0 && currency === EXPECTED_CURRENCY) return true;

    this.logger.error(
      `Refusing to grant credit for ${kind} ${sourceId} (org ${orgId}): collected ` +
        `${String(money.amount)} ${String(money.currency)}, expected a positive ` +
        `${EXPECTED_CURRENCY} amount`,
    );
    await this.logBillingAudit(orgId, 'billing.grant_amount_review', {
      kind,
      sourceId,
      amount: amount ?? null,
      currency: money.currency ?? null,
      expectedCurrency: EXPECTED_CURRENCY,
      paymentIntentId: money.paymentIntentId ?? null,
    });
    return false;
  }

  private async handleSubscriptionUpdated(
    stripeSubId: string,
    customerId: string,
    data: Record<string, unknown>,
    eventCreatedAt: Date,
  ): Promise<void> {
    const status = data['status'] as string;
    const priceId = this.extractPriceId(data);
    const plan = this.inferPlanFromPriceId(priceId);
    // `inferPlanFromPriceId` falls back to `'free'`, and there is no Stripe Price
    // for Free, so `'free'` here means "this price is not in our configuration"
    // — a rotated price id, or a subscription created outside the app. Persisting
    // the fallback would downgrade a paying customer to Free, after which the
    // free-credit worker also starts granting them a monthly allowance. Throwing
    // instead would leave the row stale for Stripe's whole retry window, so the
    // plan and price are left untouched and the mismatch is reported loudly: the
    // rest of the event (status, period, cancellation, trial) is still applied.
    const priceRecognized = plan !== 'free';
    const { periodStart, periodEnd } = this.extractBillingPeriod(data);
    const cancelAtPeriodEnd = data['cancel_at_period_end'] as boolean;
    const trialEnd = toDateFromUnixSeconds(data['trial_end']);

    const subscription = await this.resolveSubscription(customerId, stripeSubId);
    const applied = await this.applySubscriptionState(
      subscription.organizationId,
      eventCreatedAt,
      {
        stripeSubscriptionId: data['id'] as string,
        status: status ?? 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: cancelAtPeriodEnd ?? false,
        trialEnd,
        ...(priceRecognized
          ? { stripePriceId: priceId, plan, catalogVersion: BILLING_CATALOG_VERSION }
          : {}),
      },
    );
    if (!applied) return;

    if (!priceRecognized) {
      this.logger.error(
        `Subscription ${stripeSubId} uses Stripe price ${String(priceId)}, which is not in ` +
          `this deployment's price configuration; plan left unchanged. Add the price id to ` +
          `STRIPE_{STARTER,GROWTH,ENTERPRISE}_PRICE_ID and redeliver the event.`,
      );
      await this.logBillingAudit(
        subscription.organizationId,
        'billing.subscription_price_unrecognized',
        { stripeSubscriptionId: data['id'], stripePriceId: priceId, status },
      );
    }
    await this.logBillingAudit(subscription.organizationId, 'billing.subscription_synced', {
      stripeSubscriptionId: data['id'],
      stripePriceId: priceId,
      plan: priceRecognized ? plan : null,
      status,
    });
    await this.invalidateSubscriptionCache(subscription.organizationId);
  }

  private async handleSubscriptionDeleted(
    stripeSubId: string,
    eventCreatedAt: Date,
  ): Promise<void> {
    // A cancellation that matches no row used to be acknowledged as processed, so
    // a subscription we failed to link stayed `active` locally forever. Fail so
    // Stripe redelivers: the usual cause is `checkout.session.completed` not
    // having landed yet, which resolves on retry.
    const sub = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSubId },
      select: { organizationId: true },
    });
    if (!sub) {
      throw new Error(
        `customer.subscription.deleted for ${stripeSubId} matched no local subscription`,
      );
    }

    const canceled = await this.prisma.subscription.updateMany({
      where: {
        stripeSubscriptionId: stripeSubId,
        OR: [{ webhookUpdatedAt: null }, { webhookUpdatedAt: { lte: eventCreatedAt } }],
      },
      data: { status: 'canceled', webhookUpdatedAt: eventCreatedAt },
    });
    if (canceled.count === 0) {
      this.logger.warn(
        `Ignoring out-of-order customer.subscription.deleted for ${stripeSubId}: a newer ` +
          `Stripe event has already been applied`,
      );
      return;
    }

    await this.logBillingAuditForSubscription(stripeSubId, 'billing.subscription_synced', {
      stripeSubscriptionId: stripeSubId,
      status: 'canceled',
    });
    await this.invalidateSubscriptionCache(sub.organizationId);
  }

  /**
   * Applies subscription state only if this event is not older than the last one
   * already applied.
   *
   * Stripe does not guarantee delivery order, and every one of these handlers
   * used to write unconditionally while stamping `webhookUpdatedAt` with the
   * *receive* time — a value nothing ever compared. A redelivery or a slow
   * delivery could therefore resurrect a canceled subscription, rewind
   * `currentPeriodEnd`, or restore a superseded plan. Stamping Stripe's own
   * immutable event timestamp and making the comparison part of the `where`
   * clause turns the write into a compare-and-set, so two concurrent deliveries
   * cannot interleave into the older outcome.
   */
  private async applySubscriptionState(
    organizationId: string,
    eventCreatedAt: Date,
    data: Prisma.SubscriptionUpdateManyMutationInput,
  ): Promise<boolean> {
    const written = await this.prisma.subscription.updateMany({
      where: {
        organizationId,
        OR: [{ webhookUpdatedAt: null }, { webhookUpdatedAt: { lte: eventCreatedAt } }],
      },
      data: { ...data, webhookUpdatedAt: eventCreatedAt },
    });
    if (written.count === 0) {
      this.logger.warn(
        `Ignoring out-of-order Stripe subscription state for organization ${organizationId}: ` +
          `an event newer than ${eventCreatedAt.toISOString()} has already been applied`,
      );
      return false;
    }
    return true;
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
    eventCreatedAt: Date,
    stripeEventId: string,
  ): Promise<void> {
    const invoicePriceId = this.extractInvoicePriceId(data);
    const plan = this.inferPlanFromPriceId(invoicePriceId);
    if (!invoicePriceId || plan === 'free') {
      throw new Error(`Invoice ${String(data['id'])} uses an unrecognized Stripe price`);
    }
    const periodEnd = this.extractInvoicePeriodEnd(data);
    const stripeSubscriptionId = typeof data['subscription'] === 'string' ? data['subscription'] : null;
    const sub = await this.resolveSubscription(customerId, stripeSubscriptionId);

    const applied = await this.applySubscriptionState(sub.organizationId, eventCreatedAt, {
      status: 'active',
      plan,
      stripePriceId: invoicePriceId,
      catalogVersion: BILLING_CATALOG_VERSION,
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    });
    if (applied) {
      await this.logBillingAudit(sub.organizationId, 'billing.subscription_synced', {
        stripeCustomerId: customerId,
        status: 'active',
        plan,
      });
    }
    // The grant is deliberately outside that guard. An older invoice delivered
    // late still paid for its own period, and skipping it would silently keep
    // credit the customer bought. It is idempotent by invoice id in the ledger,
    // so a redelivery cannot grant twice either way.
    const invoiceId = typeof data['id'] === 'string' ? data['id'] : null;
    const includedMinutes = getPlanEntitlements(plan).includedMinutes;
    if (
      invoiceId &&
      periodEnd &&
      includedMinutes > 0 &&
      (await this.assertMoneyCollected(sub.organizationId, 'invoice', invoiceId, {
        amount: data['amount_paid'],
        currency: data['currency'],
      }))
    ) {
      await this.creditLedger.grantSubscriptionCredits({
        organizationId: sub.organizationId,
        invoiceId,
        includedMinutes,
        periodEnd,
        // Same transaction as the grant itself; see grantSubscriptionCredits.
        stripeEventId,
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
   * Stripe reversal back to the bucket that the payment funded — a pack Checkout
   * or a subscription invoice.
   */
  private async handleChargeReversal(
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (eventType === 'charge.dispute.closed' && data['status'] !== 'lost') {
      this.logger.log(`Dispute ${String(data['id'])} closed as ${String(data['status'])}; no reversal`);
      return;
    }

    const refundId = typeof data['id'] === 'string' ? data['id'] : null;
    if (!refundId) throw new Error(`${eventType} has no reversal id`);
    const paymentIntentId =
      typeof data['payment_intent'] === 'string' ? data['payment_intent'] : null;

    const target = await this.resolveReversalTarget(eventType, data, paymentIntentId);
    if (!target) return;

    const amount = typeof data['amount'] === 'number' ? data['amount'] : null;
    const amountRefunded = typeof data['amount_refunded'] === 'number' ? data['amount_refunded'] : amount;
    if (amount && amountRefunded !== amount) {
      await this.logBillingAudit(target.organizationId, 'billing.pack_partial_refund_review', {
        eventType,
        checkoutSessionId: target.sourceId,
        sourceType: target.sourceType,
        refundId,
        paymentIntentId,
        amount,
        amountRefunded,
      });
      this.logger.warn(`Partial refund ${refundId} recorded for manual review`);
      return;
    }

    await this.creditLedger.reversePurchasedCredits({
      organizationId: target.organizationId,
      checkoutSessionId: target.sourceId,
      refundId,
      sourceType: target.sourceType,
    });
    await this.logBillingAudit(target.organizationId, 'billing.pack_credit_reversed', {
      eventType,
      checkoutSessionId: target.sourceId,
      sourceType: target.sourceType,
      refundId,
      paymentIntentId,
    });
  }

  /**
   * Maps a Stripe reversal to the credit bucket it should take back, or null
   * when there is nothing to reverse.
   *
   * Returning null instead of throwing for the unmappable cases is the point.
   * This used to throw whenever a payment intent did not resolve to exactly one
   * recorded *pack* grant, which is true of every subscription refund and every
   * dispute on an invoice — so those events 500-looped for Stripe's entire retry
   * window and then gave up, masking real delivery failures the whole time. They
   * are now recorded as manual-review rows and the event terminates.
   */
  private async resolveReversalTarget(
    eventType: string,
    data: Record<string, unknown>,
    paymentIntentId: string | null,
  ): Promise<{
    organizationId: string;
    sourceType: 'purchased' | 'included';
    sourceId: string;
  } | null> {
    // A refunded subscription charge names its invoice, which is exactly the
    // `sourceId` the period's included bucket was granted under. Pack Checkouts
    // are created without invoice generation, so this branch cannot capture one.
    const invoiceId = typeof data['invoice'] === 'string' ? data['invoice'] : null;
    if (invoiceId) {
      const bucket = await this.prisma.billingCreditBucket.findFirst({
        where: { sourceType: 'included', sourceId: invoiceId },
        select: { organizationId: true },
      });
      if (bucket) {
        return { organizationId: bucket.organizationId, sourceType: 'included', sourceId: invoiceId };
      }
      await this.recordUnresolvedReversal(eventType, data, paymentIntentId, {
        invoiceId,
        reason: 'no_included_credit_for_invoice',
      });
      return null;
    }

    if (!paymentIntentId) {
      this.logger.warn(`${eventType} without a payment intent; cannot map to a credit grant`);
      return null;
    }

    // The bucket itself is the durable payment-intent → organization mapping, and
    // it is unique, so this cannot be ambiguous. Dispute payloads carry no
    // customer, which is why the mapping has to hang off the payment intent.
    const funded = await this.prisma.billingCreditBucket.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
      select: { organizationId: true, sourceType: true, sourceId: true },
    });
    if (funded) {
      return {
        organizationId: funded.organizationId,
        sourceType: funded.sourceType === 'included' ? 'included' : 'purchased',
        sourceId: funded.sourceId,
      };
    }

    // Packs granted before the bucket recorded its payment intent are only
    // reachable through the audit row the grant wrote.
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
    if (grants.length > 1) {
      // Ambiguous: reversing against the wrong one of two owners would take
      // credit from a customer nobody refunded, so nothing is reversed. It is
      // recorded rather than thrown because throwing 500-loops the event for
      // Stripe's whole retry window and then loses it — the reversal does not
      // happen either way, and only one of the two outcomes reaches a human.
      await this.recordUnresolvedReversal(eventType, data, paymentIntentId, {
        reason: 'ambiguous_payment_intent',
        organizationIds: grants.map((row) => row.organizationId),
      });
      return null;
    }
    const grant = grants[0];
    const metadata = (grant?.metadata ?? null) as { checkoutSessionId?: unknown } | null;
    const checkoutSessionId =
      typeof metadata?.checkoutSessionId === 'string' ? metadata.checkoutSessionId : null;
    if (!grant?.organizationId || !checkoutSessionId) {
      await this.recordUnresolvedReversal(eventType, data, paymentIntentId, {
        reason: 'no_recorded_grant',
      });
      return null;
    }
    return {
      organizationId: grant.organizationId,
      sourceType: 'purchased',
      sourceId: checkoutSessionId,
    };
  }

  /**
   * Records a reversal we cannot attribute to a grant, so it lands somewhere a
   * human looks instead of in a 500-loop or a warn line.
   *
   * The organization comes from the charge's customer when there is one; a
   * dispute has none, so an unattributable dispute can only be logged. That is
   * still strictly better than the previous behaviour, which retried it until
   * Stripe gave up and then forgot it entirely.
   */
  private async recordUnresolvedReversal(
    eventType: string,
    data: Record<string, unknown>,
    paymentIntentId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const reversalId = typeof data['id'] === 'string' ? data['id'] : null;
    this.logger.error(
      `${eventType} ${String(reversalId)} could not be mapped to a credit grant ` +
        `(payment intent ${String(paymentIntentId)}); recorded for manual review`,
    );
    const customerId = typeof data['customer'] === 'string' ? data['customer'] : null;
    const metadata = { eventType, reversalId, paymentIntentId, ...detail };
    if (customerId) {
      await this.logBillingAuditForCustomer(
        customerId,
        'billing.credit_reversal_unresolved',
        metadata,
      );
    }
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

  private async handleInvoicePaymentFailed(
    customerId: string,
    eventCreatedAt: Date,
  ): Promise<void> {
    const resolved = await this.resolveSubscription(customerId, null);
    // Same ordering guard as the other state writes: a failure delivered after
    // the retry that succeeded must not put a paying customer back to past_due.
    const applied = await this.applySubscriptionState(resolved.organizationId, eventCreatedAt, {
      status: 'past_due',
    });
    if (!applied) return;
    await this.logBillingAudit(resolved.organizationId, 'billing.payment_failed', {
      stripeCustomerId: customerId,
      status: 'past_due',
    });
    // No dunning email is enqueued here, deliberately. `'notifications'` is not
    // one of the queues any worker consumes (`WorkersModule` registers
    // agent-gen, analytics, audit, billing-reconciliation, call-lease-renewal,
    // digest, embeddings, evaluation, free-credit-grant, orchestrator and
    // outbound-campaign), and `EmailService` has no dunning template — so the
    // enqueue that used to be here delivered nothing, logged "Dunning email
    // queued" as if it had, and left a job in Redis that nothing would ever
    // drain. The customer-visible gap is real and is tracked as a feature: it
    // needs an `EmailService` template, a worker to drain it, and that worker
    // registered in `WorkersModule`. Until all three exist, the audited
    // `billing.payment_failed` record above is the honest trace of the event.
    this.logger.warn(
      `Payment failed for org ${resolved.organizationId} (customer ${customerId}); ` +
        `no dunning email is sent — recovery relies on Stripe's own retries.`,
    );
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
