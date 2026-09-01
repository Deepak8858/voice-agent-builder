import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import DodoPayments from 'dodopayments';
import { Prisma } from '@prisma/client';
import type { PlanType, SubscriptionStatus } from '@voiceforge/shared';
import { BILLING_CATALOG_VERSION, getPlanEntitlements } from '@voiceforge/shared';
import { CacheInvalidator } from '../common/cache-invalidator';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { CreditLedgerService } from '../billing/credit-ledger.service';

interface DodoWebhookResult {
  handled: boolean;
  message: string;
  statusCode: 200 | 400 | 500;
}

/** The three Standard Webhooks headers every Dodo delivery carries. */
export interface DodoWebhookHeaders {
  webhookId: string;
  signature: string;
  timestamp: string;
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
 * minute pack in `priceUsd` and every plan product is priced in USD. A payment in
 * anything else is either a misconfigured Dodo product or a product belonging to
 * someone else's business, and its amount cannot be compared to our catalog.
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

/**
 * A verified delivery, in the shape {@link DodoWebhookService.reclaimStuckEvents}
 * can rebuild from stored columns. That is the only reason this exists rather
 * than the SDK's `UnwrapWebhookEvent` union: a re-driven row is read back out of
 * `dodo_webhook_events`, not off the wire, so it can never be one of those types.
 */
interface DodoWebhookEvent {
  /** Standard Webhooks' `webhook-id`: the delivery's only stable identifier. */
  webhookId: string;
  type: string;
  /** The envelope's `timestamp`, or the receive time when it is unusable. */
  created: Date;
  livemode: boolean;
  data: Record<string, unknown>;
}

type DodoEventClaim = 'claimed' | 'processed' | 'processing';

/**
 * Dodo subscription status -> the status column's vocabulary (the shared
 * `SubscriptionStatusSchema`, which is still Stripe's).
 *
 * `on_hold` and `failed` both map onto a *live* status that is not paid access,
 * so dunning neither frees the organization to start a second subscription nor
 * lets it keep spending. Dodo has no `trialing`: a subscription inside its trial
 * reports `active`, and a trial is funded access, so nothing is lost by not
 * inventing one — which is also why `trialEnd` is never written from these
 * payloads (Dodo reports a trial *length*, not an end date).
 */
const DODO_STATUS_TO_LOCAL: Readonly<Record<string, SubscriptionStatus>> = {
  pending: 'incomplete',
  active: 'active',
  on_hold: 'past_due',
  failed: 'unpaid',
  paused: 'paused',
  cancelled: 'canceled',
  expired: 'canceled',
};

/** A non-empty string, or null: every id on these payloads is optional in practice. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses one of Dodo's ISO-8601 timestamps, returning null for any value that
 * would produce an `Invalid Date`. Prisma throws `PrismaClientValidationError` on
 * invalid Date objects, which would turn an otherwise-recoverable webhook into a
 * 500 and trigger redeliveries.
 */
function toDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

@Injectable()
export class DodoWebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DodoWebhookService.name);
  /**
   * The SDK's Standard Webhooks verifier, which is the only Dodo surface this
   * service touches. Using it rather than a hand-rolled HMAC keeps the signed
   * string, the `whsec_` handling, the constant-time compare and the five-minute
   * timestamp tolerance owned by the spec's own implementation.
   */
  private readonly webhooks: Pick<DodoPayments['webhooks'], 'unwrap'> | null;
  /**
   * The one read-back this service makes against the Dodo API, used by
   * {@link resolveRefundedCycle}: a refund payload names a payment and nothing
   * else, and only the payment object says which subscription that money funded.
   * Derived from the same client as {@link webhooks} so a deployment can never
   * hold one and not the other.
   */
  private readonly payments: Pick<DodoPayments['payments'], 'retrieve'> | null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditLedger: CreditLedgerService,
    private readonly cacheInvalidator?: CacheInvalidator,
  ) {
    // Both, not either: the client refuses to construct without a bearer token,
    // and `DODO_PORTAL_REQUIRED_ENV` already requires the two together, so a
    // deployment holding one and not the other has no verifiable webhook feed.
    const client =
      env.DODO_PAYMENTS_API_KEY && env.DODO_WEBHOOK_SECRET
        ? new DodoPayments({
            bearerToken: env.DODO_PAYMENTS_API_KEY,
            webhookKey: env.DODO_WEBHOOK_SECRET,
            environment: env.DODO_PAYMENTS_ENVIRONMENT,
          })
        : null;
    this.webhooks = client?.webhooks ?? null;
    this.payments = client?.payments ?? null;
  }

  async handleWebhook(
    payload: Buffer,
    headers: DodoWebhookHeaders,
  ): Promise<DodoWebhookResult> {
    if (!this.webhooks) {
      this.logger.warn('Dodo Payments not configured; skipping webhook.');
      return { handled: false, message: 'Dodo Payments not configured', statusCode: 500 };
    }

    // Before any read or write: an unsigned, tampered or stale delivery must not
    // even create an idempotency row. `unwrap` throws on a missing header, a
    // non-`v1` signature, a mismatch, or a timestamp outside the spec's
    // five-minute window.
    let event: DodoWebhookEvent;
    try {
      const envelope = asRecord(
        this.webhooks.unwrap(payload.toString('utf8'), {
          headers: {
            'webhook-id': headers.webhookId,
            'webhook-signature': headers.signature,
            'webhook-timestamp': headers.timestamp,
          },
        }),
      );
      const type = str(envelope['type']);
      if (!type) throw new Error('Webhook envelope has no event type');
      event = {
        webhookId: headers.webhookId,
        type,
        created: toDate(envelope['timestamp']) ?? new Date(),
        livemode: env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode',
        data: asRecord(envelope['data']),
      };
    } catch (err) {
      this.logger.warn(`Webhook signature verification failed: ${err}`);
      return { handled: false, message: 'Invalid signature', statusCode: 400 };
    }

    try {
      const claim = await this.claimEvent(event);
      if (claim === 'processed') {
        return {
          handled: true,
          message: `Event ${event.webhookId} already processed`,
          statusCode: 200,
        };
      }
      // A 5xx, never a 2xx. `processing` means some delivery holds the lease and
      // has NOT finished — if that delivery is the one that crashed, a 200 here
      // is Dodo's cue to stop redelivering, and the event is then lost for good:
      // the lease expires with nothing left to reclaim it. Failing keeps the
      // event inside Dodo's retry window until a delivery actually completes, and
      // a duplicate delivery of work that does complete costs nothing because the
      // second attempt sees `processed`.
      if (claim === 'processing') {
        return {
          handled: false,
          message: `Event ${event.webhookId} is already being processed`,
          statusCode: 500,
        };
      }
      await this.dispatch(event);
      await this.markProcessed(event);
      return { handled: true, message: `Event ${event.webhookId} processed`, statusCode: 200 };
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
    if (!this.webhooks) return;
    this.sweepTimer = setInterval(() => {
      void this.reclaimStuckEvents().catch((err: Error) =>
        this.logger.error(`Stuck Dodo event sweep failed: ${err.message}`),
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
   * row — but Dodo only redelivers for a bounded window, and once that closes
   * nothing ever arrives to trigger the reclaim. The row then sits `processing`
   * forever, which for a renewal or a pack payment means a customer paid and
   * never received credit, with no error recorded anywhere because the handler
   * never got to record one.
   *
   * The stored payload is the verified one this endpoint accepted, so it is
   * re-dispatched directly; every handler is idempotent by Dodo object id, so a
   * row that turns out to have completed its work simply converges. Claiming
   * through {@link claimEvent} means two replicas sweeping at once cannot both
   * take the same row.
   */
  async reclaimStuckEvents(limit = STUCK_EVENT_SWEEP_LIMIT): Promise<number> {
    const cutoff = new Date(Date.now() - STUCK_EVENT_RECLAIM_MS);
    const stuck = await this.prisma.dodoWebhookEvent.findMany({
      where: { processedAt: null, processingStartedAt: { lte: cutoff } },
      orderBy: { processingStartedAt: 'asc' },
      take: limit,
    });

    let recovered = 0;
    for (const row of stuck) {
      const event: DodoWebhookEvent = {
        webhookId: row.webhookId,
        type: row.type,
        created: row.created,
        livemode: row.livemode,
        data: asRecord(row.data),
      };
      // Anything but `claimed` means another sweep or a live delivery owns it.
      if ((await this.claimEvent(event)) !== 'claimed') continue;
      this.logger.warn(
        `Re-driving Dodo event ${row.webhookId} (${row.type}) stranded in processing ` +
          `since ${row.processingStartedAt?.toISOString() ?? 'unknown'}`,
      );
      try {
        await this.dispatch(event);
        await this.markProcessed(event);
        recovered += 1;
      } catch (err) {
        await this.markError(event, `stuck-event sweep: ${String(err)}`);
        this.logger.error(`Re-driving Dodo event ${row.webhookId} failed: ${String(err)}`);
      }
    }
    return recovered;
  }

  private async markProcessed(event: DodoWebhookEvent): Promise<void> {
    await this.prisma.dodoWebhookEvent.update({
      where: { webhookId: event.webhookId },
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
  private async claimEvent(event: DodoWebhookEvent): Promise<DodoEventClaim> {
    const now = new Date();
    try {
      await this.prisma.dodoWebhookEvent.create({
        data: this.eventData(event, now),
      });
      return 'claimed';
    } catch (err) {
      if (!this.isUniqueConstraintError(err)) throw err;
    }

    const existing = await this.prisma.dodoWebhookEvent.findUnique({
      where: { webhookId: event.webhookId },
    });
    if (existing?.processedAt) return 'processed';

    const leaseExpiry = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const reclaimed = await this.prisma.dodoWebhookEvent.updateMany({
      where: {
        webhookId: event.webhookId,
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

  private eventData(
    event: DodoWebhookEvent,
    claimedAt: Date,
  ): Prisma.DodoWebhookEventCreateInput {
    return {
      webhookId: event.webhookId,
      type: event.type,
      // Dodo's envelope carries no API version and no delivery-attempt count, so
      // the two columns inherited from the Stripe-era table stay at their
      // defaults rather than being filled with something invented here.
      apiVersion: null,
      created: event.created,
      data: event.data as Prisma.InputJsonValue,
      livemode: event.livemode,
      processingStartedAt: claimedAt,
      attemptCount: 1,
    };
  }

  private isUniqueConstraintError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
  }

  /**
   * The failed attempt's claim timestamp is KEPT, not cleared.
   * `DodoWebhookEvent` has no `updatedAt`, and {@link reclaimStuckEvents} ages
   * rows by `processingStartedAt`; clearing it made every errored row invisible
   * to the sweep (`null` never satisfies `lte`), so a re-drive that failed once
   * was stranded forever — a permanently unapplied billing state change. Keeping
   * it re-arms the same {@link STUCK_EVENT_RECLAIM_MS} backoff the sweep already
   * uses, measured from the last attempt, and {@link claimEvent} bumps
   * `attemptCount` on each re-drive so a genuinely dead event is visible as a
   * climbing count rather than dropped. Nothing is lost inside Dodo's own retry
   * window either: a redelivery arriving while this claim is still fresh gets
   * `processing` and a 500, so Dodo simply retries again.
   */
  private async markError(event: DodoWebhookEvent, errorMessage: string): Promise<void> {
    await this.prisma.dodoWebhookEvent.upsert({
      where: { webhookId: event.webhookId },
      create: {
        webhookId: event.webhookId,
        type: event.type,
        apiVersion: null,
        created: event.created,
        data: event.data as Prisma.InputJsonValue,
        livemode: event.livemode,
        // Only reached when the claim itself failed before writing a row; without
        // a claim stamp this row would be invisible to the sweep as well.
        processingStartedAt: new Date(),
        errorMessage,
      },
      update: { errorMessage },
    });
  }

  private async dispatch(event: DodoWebhookEvent): Promise<void> {
    switch (event.type) {
      case 'payment.succeeded':
        await this.handlePaymentSucceeded(event);
        break;
      // Both fund a billing period, so both run the same grant. `subscription.active`
      // additionally links the subscription to its organization, because there is no
      // separate checkout-completed event to do it.
      case 'subscription.active':
      case 'subscription.renewed':
        await this.handleSubscriptionCycle(event);
        break;
      case 'subscription.plan_changed':
        await this.handleSubscriptionPlanChanged(event);
        break;
      case 'subscription.on_hold':
      case 'subscription.failed':
        await this.handleSubscriptionDunning(event);
        break;
      case 'subscription.cancelled':
      case 'subscription.expired':
        await this.handleSubscriptionEnded(event);
        break;
      case 'refund.succeeded':
      case 'dispute.lost':
        await this.handleReversal(event.type, event.data);
        break;
      // Subscribed to, and deliberately money-neutral. Both are recorded by
      // `claimEvent` for support to read back; neither moves credit. A dispute
      // that was WON is the reason `dispute.lost` and not `dispute.*` drives the
      // reversal — the customer keeps what they paid for.
      case 'payment.failed':
      case 'dispute.won':
        this.logger.warn(
          `${event.type} for payment ${String(str(event.data['payment_id']))}; recorded, ` +
            `no credit moved`,
        );
        break;
      // Anything this deployment does not know is recorded and acknowledged the
      // same way. No money moves on a signal that no money moved.
      default:
        this.logger.debug(`Unhandled Dodo event type: ${event.type}`);
    }
  }

  /**
   * One-time money. A payment naming a subscription is deliberately ignored here:
   * the subscription cycle events own subscription credit because they are the
   * only ones that name the period the money bought, and granting from both would
   * double-grant every renewal.
   */
  private async handlePaymentSucceeded(event: DodoWebhookEvent): Promise<void> {
    const data = event.data;
    const paymentId = str(data['payment_id']);
    if (!paymentId) throw new Error('payment.succeeded carries no payment_id');

    const subscriptionId = str(data['subscription_id']);
    if (subscriptionId) {
      this.logger.log(
        `Payment ${paymentId} funds subscription ${subscriptionId}; the subscription ` +
          `events grant its credit`,
      );
      return;
    }

    const packProductId = env.DODO_MINUTE_PACK_PRODUCT_ID;
    const cart = Array.isArray(data['product_cart']) ? data['product_cart'] : [];
    const isMinutePack =
      Boolean(packProductId) &&
      cart.some((item) => str(asRecord(item)['product_id']) === packProductId);
    if (!isMinutePack) {
      this.logger.warn(
        `Payment ${paymentId} is not for a configured product; recorded without a grant`,
      );
      return;
    }

    const orgId = str(asRecord(data['metadata'])['organizationId']);
    const customerId = str(asRecord(data['customer'])['customer_id']);
    if (!orgId || !customerId) {
      // Money was collected for a pack this deployment sells, so this is not a
      // shrug: without an organization there is nothing to grant to and nothing
      // to audit against either, so the log line is the only trace there can be.
      this.logger.error(
        `Minute-pack payment ${paymentId} names no organization (metadata) or no ` +
          `customer; credit cannot be granted automatically`,
      );
      return;
    }

    await this.handleMinutePackPurchase(orgId, customerId, paymentId, event);
  }

  /**
   * Grants the prepaid pack only when Dodo reports the money as collected and the
   * organization named in metadata actually owns the customer that paid. Metadata
   * is client-influenced at Checkout creation time, so trusting it alone would let
   * one organization fund another's balance.
   */
  private async handleMinutePackPurchase(
    orgId: string,
    customerId: string,
    paymentId: string,
    event: DodoWebhookEvent,
  ): Promise<void> {
    const status = str(event.data['status']);
    // `payment.succeeded` should only ever carry `succeeded`. Anything else means
    // the event and its payload disagree about whether money was collected, which
    // is a manual-review row rather than a grant.
    if (status && status !== 'succeeded') {
      this.logger.error(
        `Minute-pack payment ${paymentId} for org ${orgId} arrived on payment.succeeded ` +
          `with status ${status}; refusing to grant credit`,
      );
      await this.logBillingAudit(orgId, 'billing.pack_payment_status_review', {
        paymentId,
        dodoCustomerId: customerId,
        status,
      });
      return;
    }

    const owner = await this.prisma.subscription.findFirst({
      where: { organizationId: orgId, dodoCustomerId: customerId },
      select: { organizationId: true },
    });
    if (!owner) {
      this.logger.error(
        `Minute-pack payment ${paymentId} claims org ${orgId} but customer ${customerId} ` +
          `is not owned by it; refusing to grant credit`,
      );
      return;
    }

    if (
      !(await this.assertMoneyCollected(orgId, 'pack_payment', paymentId, {
        amount: event.data['total_amount'],
        currency: event.data['currency'],
        paymentId,
      }))
    ) {
      return;
    }

    await this.creditLedger.grantPurchasedCredits({
      organizationId: orgId,
      paymentId,
      // The event's immutable timestamp keeps retries byte-for-byte idempotent and
      // prevents a delayed delivery from extending expiry.
      purchasedAt: event.created,
      // Acknowledging the event is part of the grant's own transaction, so a
      // crash cannot leave money granted and the event looking undelivered.
      webhookId: event.webhookId,
    });
    await this.logBillingAudit(orgId, PACK_GRANT_ACTION, {
      paymentId,
      dodoCustomerId: customerId,
      catalogVersion: BILLING_CATALOG_VERSION,
      // What the buyer actually settled, in their localized currency — the pack
      // grant no longer requires USD (MoR localization), so this is the record
      // an operator reads when reconciling a grant against a payout.
      collectedAmount: event.data['total_amount'] ?? null,
      collectedCurrency: event.data['currency'] ?? null,
    });
  }

  /**
   * Refuses to grant credit for a cycle or purchase that collected no money, or
   * collected it in a currency this deployment does not price in.
   *
   * A mismatch is a manual-review row rather than a throw: the event is not going
   * to succeed on retry, so failing it forever would only bury the signal under a
   * permanently red webhook.
   *
   * Returns true when the grant may proceed.
   */
  private async assertMoneyCollected(
    orgId: string,
    kind: 'pack_payment' | 'subscription_cycle',
    sourceId: string,
    money: { amount: unknown; currency: unknown; paymentId?: string | null },
  ): Promise<boolean> {
    const amount = typeof money.amount === 'number' ? money.amount : null;
    const currency = typeof money.currency === 'string' ? money.currency.toLowerCase() : null;
    // The two kinds read DIFFERENT resources and their currencies mean different
    // things. A subscription cycle reads the subscription object, whose
    // `recurring_pre_tax_amount`/`currency` are the PRODUCT's own — always the
    // catalog's USD unless a product was misconfigured, which is exactly what the
    // equality catches. A pack payment reads the payment object, whose
    // `total_amount`/`currency` are what the BUYER settled in: Dodo is a Merchant
    // of Record and localizes at checkout, so a $39 pack legitimately arrives as
    // e.g. `1155716 INR` (observed live in the 2026-08-31 test-mode E2E — a $99
    // subscription's payment settled as INR with GST folded in). Requiring USD
    // here made every non-USD buyer pay for a pack and never receive it. The
    // price itself is not assertable from the payment (converted, tax-inclusive);
    // it is protected upstream by the server-owned product in the cart. So the
    // pack check is: positive money, any currency, with the observed currency
    // kept in the audit trail below.
    const currencyOk =
      kind === 'subscription_cycle' ? currency === EXPECTED_CURRENCY : currency !== null;
    if (amount !== null && amount > 0 && currencyOk) return true;

    const expected =
      kind === 'subscription_cycle' ? `positive ${EXPECTED_CURRENCY}` : 'positive';
    this.logger.error(
      `Refusing to grant credit for ${kind} ${sourceId} (org ${orgId}): collected ` +
        `${String(money.amount)} ${String(money.currency)}, expected a ${expected} amount`,
    );
    await this.logBillingAudit(orgId, 'billing.grant_amount_review', {
      kind,
      sourceId,
      amount: amount ?? null,
      currency: money.currency ?? null,
      expectedCurrency: kind === 'subscription_cycle' ? EXPECTED_CURRENCY : 'any',
      paymentId: money.paymentId ?? null,
    });
    return false;
  }

  /**
   * A funded billing period: first activation or a renewal. This is the only place
   * included minutes are granted, and the plan comes from the server-owned product
   * map on the payload rather than from any client-supplied value.
   */
  private async handleSubscriptionCycle(event: DodoWebhookEvent): Promise<void> {
    const data = event.data;
    const subscriptionId = str(data['subscription_id']);
    const customerId = str(asRecord(data['customer'])['customer_id']);
    if (!subscriptionId || !customerId) {
      throw new Error(`${event.type} carries no subscription_id or customer`);
    }

    const orgId =
      event.type === 'subscription.active'
        ? await this.linkSubscription(event, subscriptionId, customerId)
        : (await this.resolveSubscription(customerId, subscriptionId)).organizationId;
    if (!orgId) return;

    const productId = str(data['product_id']);
    const plan = this.inferPlanFromProductId(productId);
    if (plan === 'free') {
      throw new Error(
        `Subscription ${subscriptionId} uses product ${String(productId)}, which is not in ` +
          `this deployment's product configuration. Add it to ` +
          `DODO_{STARTER,GROWTH,ENTERPRISE}_PRODUCT_ID and redeliver the event.`,
      );
    }

    const periodStart = toDate(data['previous_billing_date']);
    const periodEnd = toDate(data['next_billing_date']);
    const applied = await this.applySubscriptionState(orgId, event.created, {
      dodoSubscriptionId: subscriptionId,
      dodoCustomerId: customerId,
      dodoProductId: productId,
      dodoMetadata: asRecord(data['metadata']) as Prisma.InputJsonValue,
      plan,
      catalogVersion: BILLING_CATALOG_VERSION,
      // Spread, not `?? 'active'`: localStatus's null contract is "leave the
      // stored status untouched", and defaulting an unreviewed provider status
      // to active would fund usage on it. A brand-new row was created
      // 'incomplete' by linkSubscription, which PAID_ACCESS_STATUSES excludes,
      // so the omission fails closed either way.
      ...(this.localStatus(data['status']) !== null
        ? { status: this.localStatus(data['status'])! }
        : {}),
      cancelAtPeriodEnd: data['cancel_at_next_billing_date'] === true,
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    });
    if (applied) {
      await this.logBillingAudit(orgId, 'billing.subscription_synced', {
        dodoSubscriptionId: subscriptionId,
        dodoCustomerId: customerId,
        dodoProductId: productId,
        plan,
        status: str(data['status']),
      });
    }

    // The grant is deliberately outside that guard. An older cycle delivered late
    // still paid for its own period, and skipping it would silently keep credit
    // the customer bought. It is idempotent by grant key in the ledger, so a
    // redelivery cannot grant twice either way.
    const grantKey = this.cycleGrantKey(subscriptionId, periodStart);
    const includedMinutes = getPlanEntitlements(plan).includedMinutes;
    if (
      periodEnd &&
      includedMinutes > 0 &&
      (await this.assertMoneyCollected(orgId, 'subscription_cycle', grantKey, {
        amount: data['recurring_pre_tax_amount'],
        currency: data['currency'],
      }))
    ) {
      await this.creditLedger.grantSubscriptionCredits({
        organizationId: orgId,
        paymentId: grantKey,
        includedMinutes,
        periodEnd,
        // Same transaction as the grant itself; see grantSubscriptionCredits.
        webhookId: event.webhookId,
      });
      await this.logBillingAudit(orgId, 'billing.included_credit_granted', {
        paymentId: grantKey,
        plan,
        includedMinutes,
        periodEnd: periodEnd.toISOString(),
        catalogVersion: BILLING_CATALOG_VERSION,
      });
    }

    await this.invalidateSubscriptionCache(orgId);
  }

  /**
   * The key one billing cycle's included grant is idempotent under.
   *
   * Dodo's subscription payloads carry no payment id — unlike a Stripe invoice,
   * which was both the money and the period — so the cycle is identified by the
   * subscription plus the boundary it started at. `subscription.active` and
   * `subscription.renewed` for the *same* cycle therefore derive the same key and
   * cannot grant twice, which a per-event-type key would not have prevented.
   */
  private cycleGrantKey(subscriptionId: string, periodStart: Date | null): string {
    return periodStart
      ? `sub:${subscriptionId}:${periodStart.toISOString()}`
      : `sub:${subscriptionId}:activation`;
  }

  /**
   * Binds a newly-active subscription to the organization that owns it, and
   * returns that organization — or null when the link would overwrite an existing
   * one, which is refused rather than applied.
   *
   * Metadata is set by us at Checkout creation but is client-influenced in the
   * sense that it travels through the customer's browser session, so it is never
   * the only evidence: an organization named in metadata must not already be
   * linked to a *different* Dodo object, and the customer it claims must not
   * already belong to someone else. A payload without metadata falls back to the
   * customer -> organization mapping `getOrCreateCustomer` wrote before checkout,
   * which is entirely server-owned.
   */
  private async linkSubscription(
    event: DodoWebhookEvent,
    subscriptionId: string,
    customerId: string,
  ): Promise<string | null> {
    const claimedOrgId = str(asRecord(event.data['metadata'])['organizationId']);
    const orgId = claimedOrgId ?? (await this.resolveLinkOwner(customerId, subscriptionId));

    const conflict = await this.findSubscriptionLinkConflict(orgId, customerId, subscriptionId);
    if (conflict) {
      this.logger.error(
        `Subscription ${subscriptionId} would relink org ${orgId} ${conflict.field} from ` +
          `${conflict.current} to ${conflict.incoming}; refusing to overwrite the existing link`,
      );
      await this.logBillingAudit(orgId, 'billing.subscription_link_conflict', {
        dodoSubscriptionId: subscriptionId,
        field: conflict.field,
        current: conflict.current,
        incoming: conflict.incoming,
      });
      return null;
    }

    // Upsert, because a sales-assisted subscription created in the Dodo dashboard
    // has never been through `getOrCreateCustomer` and so has no row yet. The real
    // plan, status and period land in `applySubscriptionState`, which is ordering-
    // guarded; this only establishes the identity it writes against.
    await this.prisma.subscription.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        dodoCustomerId: customerId,
        dodoSubscriptionId: subscriptionId,
        plan: 'free',
        status: 'incomplete',
      },
      update: { dodoCustomerId: customerId, dodoSubscriptionId: subscriptionId },
    });
    return orgId;
  }

  /**
   * Reports the first Dodo identifier on the organization's subscription row that
   * this activation would change to a different non-null value, or null when the
   * link is new or unchanged.
   */
  private async findSubscriptionLinkConflict(
    orgId: string,
    customerId: string,
    subscriptionId: string,
  ): Promise<{ field: string; current: string; incoming: string } | null> {
    // A null `dodoCustomerId` on our row is not evidence that the incoming
    // customer is unclaimed. An activation naming an organization that has never
    // had a customer id would otherwise have the *paying* customer's id written
    // onto that organization's row — and the payer's future renewals would then
    // grant credit to someone else's balance.
    const foreignOwner = await this.prisma.subscription.findFirst({
      where: { dodoCustomerId: customerId, organizationId: { not: orgId } },
      select: { organizationId: true },
    });
    if (foreignOwner) {
      return {
        field: 'dodoCustomerId',
        current: `held by organization ${foreignOwner.organizationId}`,
        incoming: customerId,
      };
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      select: { dodoCustomerId: true, dodoSubscriptionId: true },
    });
    if (!existing) return null;
    if (existing.dodoCustomerId && existing.dodoCustomerId !== customerId) {
      return {
        field: 'dodoCustomerId',
        current: existing.dodoCustomerId,
        incoming: customerId,
      };
    }
    if (existing.dodoSubscriptionId && existing.dodoSubscriptionId !== subscriptionId) {
      return {
        field: 'dodoSubscriptionId',
        current: existing.dodoSubscriptionId,
        incoming: subscriptionId,
      };
    }
    return null;
  }

  /**
   * A plan change. Unlike a cycle event this never grants: the money for the new
   * plan arrives as its own `subscription.renewed`, and the customer's included
   * balance is re-based there.
   *
   * `inferPlanFromProductId` falls back to `'free'`, and there is no Dodo product
   * for Free, so `'free'` here means "this product is not in our configuration" —
   * a rotated product id, or a subscription changed outside the app. Persisting
   * the fallback would downgrade a paying customer to Free, after which the
   * free-credit worker also starts granting them a monthly allowance. Throwing
   * instead would leave the row stale for Dodo's whole retry window, so the plan
   * and product are left untouched and the mismatch is reported loudly: the rest
   * of the event (status, period, cancellation) is still applied.
   */
  private async handleSubscriptionPlanChanged(event: DodoWebhookEvent): Promise<void> {
    const data = event.data;
    const subscriptionId = str(data['subscription_id']);
    const customerId = str(asRecord(data['customer'])['customer_id']);
    if (!subscriptionId || !customerId) {
      throw new Error('subscription.plan_changed carries no subscription_id or customer');
    }
    const productId = str(data['product_id']);
    const plan = this.inferPlanFromProductId(productId);
    const productRecognized = plan !== 'free';
    const periodStart = toDate(data['previous_billing_date']);
    const periodEnd = toDate(data['next_billing_date']);
    const status = str(data['status']);

    const { organizationId } = await this.resolveSubscription(customerId, subscriptionId);
    const applied = await this.applySubscriptionState(organizationId, event.created, {
      dodoSubscriptionId: subscriptionId,
      // Same null contract as handleSubscriptionCycle: an unmapped provider
      // status leaves the stored, reviewed status in place instead of guessing.
      ...(this.localStatus(data['status']) !== null
        ? { status: this.localStatus(data['status'])! }
        : {}),
      cancelAtPeriodEnd: data['cancel_at_next_billing_date'] === true,
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      ...(productRecognized
        ? { dodoProductId: productId, plan, catalogVersion: BILLING_CATALOG_VERSION }
        : {}),
    });
    if (!applied) return;

    if (!productRecognized) {
      this.logger.error(
        `Subscription ${subscriptionId} uses Dodo product ${String(productId)}, which is not ` +
          `in this deployment's product configuration; plan left unchanged. Add the product ` +
          `id to DODO_{STARTER,GROWTH,ENTERPRISE}_PRODUCT_ID and redeliver the event.`,
      );
      await this.logBillingAudit(organizationId, 'billing.subscription_product_unrecognized', {
        dodoSubscriptionId: subscriptionId,
        dodoProductId: productId,
        status,
      });
    }
    await this.logBillingAudit(organizationId, 'billing.subscription_synced', {
      dodoSubscriptionId: subscriptionId,
      dodoProductId: productId,
      plan: productRecognized ? plan : null,
      status,
    });
    await this.invalidateSubscriptionCache(organizationId);
  }

  /**
   * Dunning: `subscription.on_hold` and `subscription.failed`. No grant, and the
   * status stops paid usage without pretending the subscription is gone — Dodo
   * still holds it, so a second checkout must stay refused.
   */
  private async handleSubscriptionDunning(event: DodoWebhookEvent): Promise<void> {
    const data = event.data;
    const subscriptionId = str(data['subscription_id']);
    const customerId = str(asRecord(data['customer'])['customer_id']);
    if (!subscriptionId || !customerId) {
      throw new Error(`${event.type} carries no subscription_id or customer`);
    }
    const status: SubscriptionStatus = event.type === 'subscription.failed' ? 'unpaid' : 'past_due';

    const resolved = await this.resolveSubscription(customerId, subscriptionId);
    // Same ordering guard as the other state writes: a failure delivered after
    // the retry that succeeded must not put a paying customer back to past_due.
    const applied = await this.applySubscriptionState(resolved.organizationId, event.created, {
      status,
    });
    if (!applied) return;
    await this.logBillingAudit(resolved.organizationId, 'billing.payment_failed', {
      dodoSubscriptionId: subscriptionId,
      dodoCustomerId: customerId,
      status,
    });
    await this.invalidateSubscriptionCache(resolved.organizationId);
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
      `Payment failed for org ${resolved.organizationId} (subscription ${subscriptionId}); ` +
        `no dunning email is sent — recovery relies on Dodo's own retries.`,
    );
  }

  /**
   * `subscription.cancelled` and `subscription.expired`: the subscription is gone.
   * The plan falls back to `free` alongside the status so the stored row stops
   * claiming a paid tier; paid access was already lost by the status alone, so no
   * entitlement changes hands here that had not already changed.
   */
  private async handleSubscriptionEnded(event: DodoWebhookEvent): Promise<void> {
    const subscriptionId = str(event.data['subscription_id']);
    if (!subscriptionId) throw new Error(`${event.type} carries no subscription_id`);

    // A cancellation that matches no row used to be acknowledged as processed, so
    // a subscription we failed to link stayed `active` locally forever. Fail so
    // Dodo redelivers: the usual cause is `subscription.active` not having landed
    // yet, which resolves on retry.
    const sub = await this.prisma.subscription.findFirst({
      where: { dodoSubscriptionId: subscriptionId },
      select: { organizationId: true },
    });
    if (!sub) {
      throw new Error(`${event.type} for ${subscriptionId} matched no local subscription`);
    }

    const canceled = await this.prisma.subscription.updateMany({
      where: {
        dodoSubscriptionId: subscriptionId,
        OR: [{ webhookUpdatedAt: null }, { webhookUpdatedAt: { lte: event.created } }],
      },
      data: {
        status: 'canceled',
        plan: 'free',
        catalogVersion: BILLING_CATALOG_VERSION,
        webhookUpdatedAt: event.created,
      },
    });
    if (canceled.count === 0) {
      this.logger.warn(
        `Ignoring out-of-order ${event.type} for ${subscriptionId}: a newer Dodo event ` +
          `has already been applied`,
      );
      return;
    }

    await this.logBillingAuditForSubscription(subscriptionId, 'billing.subscription_synced', {
      dodoSubscriptionId: subscriptionId,
      status: 'canceled',
      plan: 'free',
    });
    await this.invalidateSubscriptionCache(sub.organizationId);
  }

  /**
   * Applies subscription state only if this event is not older than the last one
   * already applied.
   *
   * Dodo does not guarantee delivery order, and every one of these handlers used
   * to write unconditionally while stamping `webhookUpdatedAt` with the *receive*
   * time — a value nothing ever compared. A redelivery or a slow delivery could
   * therefore resurrect a canceled subscription, rewind `currentPeriodEnd`, or
   * restore a superseded plan. Stamping the provider's own immutable event
   * timestamp and making the comparison part of the `where` clause turns the write
   * into a compare-and-set, so two concurrent deliveries cannot interleave into
   * the older outcome.
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
        `Ignoring out-of-order Dodo subscription state for organization ${organizationId}: ` +
          `an event newer than ${eventCreatedAt.toISOString()} has already been applied`,
      );
      return false;
    }
    return true;
  }

  /**
   * A refund or a lost dispute removes the credit the payment bought. The ledger
   * decides whether the unused remainder can simply be withdrawn or whether
   * consumed credit forces manual review; this handler only maps the reversal back
   * to the bucket that the payment funded.
   */
  private async handleReversal(
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const reversalId = str(data['refund_id']) ?? str(data['dispute_id']);
    if (!reversalId) throw new Error(`${eventType} has no reversal id`);
    const paymentId = str(data['payment_id']);

    const target = await this.resolveReversalTarget(eventType, data, paymentId);
    if (!target) return;

    // Dodo says outright whether a refund was partial, so there is no amount
    // arithmetic to get wrong. A lost dispute is always for the full disputed
    // amount and carries no partial flag.
    if (data['is_partial'] === true) {
      await this.logBillingAudit(target.organizationId, 'billing.pack_partial_refund_review', {
        eventType,
        paymentId: target.sourceId,
        sourceType: target.sourceType,
        refundId: reversalId,
        amount: data['amount'] ?? null,
      });
      this.logger.warn(`Partial refund ${reversalId} recorded for manual review`);
      return;
    }

    await this.creditLedger.reversePurchasedCredits({
      organizationId: target.organizationId,
      paymentId: target.sourceId,
      refundId: reversalId,
      sourceType: target.sourceType,
    });
    await this.logBillingAudit(target.organizationId, 'billing.pack_credit_reversed', {
      eventType,
      paymentId: target.sourceId,
      sourceType: target.sourceType,
      refundId: reversalId,
    });
  }

  /**
   * Maps a reversal to the credit bucket it should take back, or null when there
   * is nothing this deployment can attribute it to.
   *
   * Returning null instead of throwing for the unmappable cases is the point: a
   * throw 500-loops the event for the provider's entire retry window and then
   * gives up, masking real delivery failures the whole time. Those events are
   * recorded as manual-review rows and terminate.
   *
   * A refunded *subscription cycle* cannot be resolved from the payload at all —
   * see {@link resolveRefundedCycle}, which reads the payment back from Dodo to
   * find it. Whatever that learns is folded into the review row, so an
   * unresolvable cycle refund is at least legible.
   */
  private async resolveReversalTarget(
    eventType: string,
    data: Record<string, unknown>,
    paymentId: string | null,
  ): Promise<{
    organizationId: string;
    sourceType: 'purchased' | 'included';
    sourceId: string;
  } | null> {
    if (!paymentId) {
      this.logger.warn(`${eventType} without a payment id; cannot map to a credit grant`);
      return null;
    }

    // The bucket itself is the durable payment -> organization mapping, and
    // `dodo_payment_id` is unique, so this cannot be ambiguous. Dispute payloads
    // carry no customer, which is why the mapping has to hang off the payment.
    const funded = await this.prisma.billingCreditBucket.findUnique({
      where: { dodoPaymentId: paymentId },
      select: { organizationId: true, sourceType: true, sourceId: true },
    });
    if (funded) {
      return {
        organizationId: funded.organizationId,
        sourceType: funded.sourceType === 'included' ? 'included' : 'purchased',
        sourceId: funded.sourceId,
      };
    }

    // The Stripe version had two more fallbacks here — an invoice -> included
    // bucket lookup and an audit-log scan by payment intent — because a Checkout
    // session id and a PaymentIntent id could name the same money. Dodo has one
    // payment id and `grantPurchasedCredits` always writes it onto the bucket, so
    // for a PACK the lookup above is the only one those fallbacks could have
    // reached. An included (cycle) bucket carries no payment id at all, so it can
    // only be found by asking Dodo what the payment funded.
    const cycle = await this.resolveRefundedCycle(paymentId);
    if ('target' in cycle) return cycle.target;

    await this.recordUnresolvedReversal(eventType, data, paymentId, cycle.detail);
    return null;
  }

  /**
   * The included bucket a refunded subscription cycle was granted from, or the
   * detail of why it could not be identified.
   *
   * Dodo's refund and dispute payloads name a payment and nothing else, while an
   * included bucket is keyed by cycle (`sub:<subscriptionId>:<previousBillingDate>`)
   * with `dodo_payment_id` null — the subscription events that grant it carry no
   * payment id — so the payment has to be read back from Dodo to learn which
   * subscription the money belonged to. That call runs only after the signature
   * was verified and the event claimed, and a failure degrades to the
   * manual-review row rather than failing the delivery: the refund already
   * happened at Dodo, and a 500-loop would not undo it.
   *
   * The period join below is the same one `bucketCoversPayment` in
   * `billing/reconciliation.service.ts` applies to the drift comparison: the
   * bucket whose period had not yet ended when the money was collected. The two
   * are deliberately separate implementations (an in-memory predicate over a
   * fetched list there, one query here, because the shapes differ) and they must
   * stay in step — if they ever attribute a payment to different cycles, a refund
   * would claw back one period while drift reported another as unfunded.
   *
   * Fail-closed at every step: exactly one covering bucket is reversed, zero or
   * several are reviewed by a human. Never a guess.
   */
  private async resolveRefundedCycle(paymentId: string): Promise<
    | { target: { organizationId: string; sourceType: 'included'; sourceId: string } }
    | { detail: Record<string, unknown> }
  > {
    if (!this.payments) {
      return { detail: { reason: 'no_recorded_grant', dodoConfigured: false } };
    }

    // Field reads inside the try as well, so a payload shaped differently from the
    // SDK's types degrades the same way a network failure does.
    let subscriptionId: string | null;
    let customerId: string | null;
    let paidAt: Date | null;
    try {
      const payment = await this.payments.retrieve(paymentId);
      subscriptionId = str(payment.subscription_id);
      customerId = str(payment.customer.customer_id);
      paidAt = toDate(payment.created_at);
    } catch (err) {
      this.logger.error(`Retrieving Dodo payment ${paymentId} failed: ${String(err)}`);
      return { detail: { reason: 'payment_retrieve_failed', retrieveError: String(err) } };
    }

    // No subscription means this was a one-off, and the pack lookup already
    // missed it: there is no recorded grant anywhere.
    if (!subscriptionId || !customerId || !paidAt) {
      return {
        detail: {
          reason: 'no_recorded_grant',
          dodoSubscriptionId: subscriptionId,
          dodoCustomerId: customerId,
        },
      };
    }

    // Both ids, not just the subscription: `resolveSubscription` requires exactly
    // one local row carrying this customer AND this subscription, so the reversal
    // can only ever reach the organization that owns both.
    let organizationId: string;
    try {
      ({ organizationId } = await this.resolveSubscription(customerId, subscriptionId));
    } catch (err) {
      return {
        detail: {
          reason: 'subscription_not_linked',
          dodoSubscriptionId: subscriptionId,
          dodoCustomerId: customerId,
          resolveError: String(err),
        },
      };
    }

    // `expiresAt > paidAt` alone is not enough: after renewals, every LATER
    // cycle's bucket shares the prefix and also outlives the refunded payment,
    // so an old cycle's refund would always read as ambiguous. The lower bound —
    // cycle start on or before the payment — lives in the sourceId itself
    // (`sub:<id>:<previousBillingDate>`), which SQL cannot parse, so the query
    // over-fetches a few rows and the date filter runs here. `:activation` keys
    // carry no date and pass the lower bound by construction: an activation
    // bucket's cycle started when the subscription did, before any payment that
    // refunds against it.
    const candidates = await this.prisma.billingCreditBucket.findMany({
      where: {
        organizationId,
        sourceType: 'included',
        sourceId: { startsWith: `sub:${subscriptionId}:` },
        expiresAt: { gt: paidAt },
      },
      select: { sourceId: true },
      take: 10,
    });
    // The grace widens the lower bound rather than narrowing it: if a renewal's
    // payment timestamp lands seconds BEFORE the cycle start Dodo stamps on the
    // subscription, a strict bound would exclude the right bucket and leave
    // exactly one WRONG (previous-cycle) match — an auto-reversal of money the
    // customer legitimately consumed. Inside the grace both cycles match, which
    // is ambiguous, which is a human. Fail closed, never fail wrong.
    const CYCLE_START_GRACE_MS = 15 * 60 * 1000;
    const covering = candidates.filter((row) => {
      const suffix = row.sourceId.slice(`sub:${subscriptionId}:`.length);
      if (suffix === 'activation') return true;
      const cycleStart = new Date(suffix);
      return (
        !Number.isNaN(cycleStart.getTime()) &&
        cycleStart.getTime() <= paidAt.getTime() + CYCLE_START_GRACE_MS
      );
    });
    const bucket = covering.length === 1 ? covering[0] : undefined;
    if (!bucket) {
      return {
        detail: {
          reason: covering.length === 0 ? 'no_cycle_bucket' : 'ambiguous_cycle_bucket',
          dodoSubscriptionId: subscriptionId,
          dodoCustomerId: customerId,
          coveringBuckets: covering.length,
          paidAt: paidAt.toISOString(),
        },
      };
    }
    return {
      target: { organizationId, sourceType: 'included', sourceId: bucket.sourceId },
    };
  }

  /**
   * Records a reversal we cannot attribute to a grant, so it lands somewhere a
   * human looks instead of in a 500-loop or a warn line.
   *
   * The organization comes from the refund's customer when there is one. A dispute
   * payload has none, so the fallback is the customer `resolveRefundedCycle`
   * learned from the payment object — without it an unattributable dispute could
   * only ever be logged, never audited.
   */
  private async recordUnresolvedReversal(
    eventType: string,
    data: Record<string, unknown>,
    paymentId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const reversalId = str(data['refund_id']) ?? str(data['dispute_id']);
    this.logger.error(
      `${eventType} ${String(reversalId)} could not be mapped to a credit grant ` +
        `(payment ${String(paymentId)}); recorded for manual review`,
    );
    const customerId =
      str(asRecord(data['customer'])['customer_id']) ?? str(detail['dodoCustomerId']);
    if (!customerId) return;
    await this.logBillingAuditForCustomer(customerId, 'billing.credit_reversal_unresolved', {
      eventType,
      reversalId,
      paymentId,
      ...detail,
    });
  }

  /**
   * Subscription reads are cached for a minute. Without this, a customer who
   * just paid keeps seeing their old plan (and old limits) until the TTL
   * expires.
   */
  private async invalidateSubscriptionCache(organizationId: string): Promise<void> {
    await this.cacheInvalidator?.invalidateBillingSubscription(organizationId);
  }

  /**
   * Only server-owned product IDs may name a plan. Anything else resolves to Free
   * so a product created outside our configuration cannot grant paid entitlements.
   */
  private inferPlanFromProductId(productId: string | null): PlanType {
    if (productId && productId === env.DODO_STARTER_PRODUCT_ID) return 'starter';
    if (productId && productId === env.DODO_GROWTH_PRODUCT_ID) return 'growth';
    if (productId && productId === env.DODO_ENTERPRISE_PRODUCT_ID) return 'enterprise';
    return 'free';
  }

  /**
   * A Dodo status in the column's vocabulary, or null for one this deployment does
   * not know. Null leaves `status` untouched rather than guessing: mapping an
   * unknown status to `active` would fund usage on a state nobody has reviewed,
   * and mapping it to a dead status would cut off a paying customer.
   */
  private localStatus(value: unknown): SubscriptionStatus | null {
    const status = str(value);
    if (!status) return null;
    const local = DODO_STATUS_TO_LOCAL[status];
    if (!local) {
      this.logger.error(
        `Dodo subscription status "${status}" is not in this deployment's status map; ` +
          `the stored status is left unchanged`,
      );
      return null;
    }
    return local;
  }

  /**
   * The organization owning a metadata-less activation, from the customer ->
   * organization mapping `getOrCreateCustomer` writes before checkout.
   *
   * `resolveSubscription` is not reused here because its "exactly one" contract
   * reports "no local row" and "several rows" through one message, and they are
   * different failures with different fixes. No row is a subscription created
   * straight in the Dodo dashboard: it can only be linked when the activation
   * carries an `organizationId` in metadata (which the caller's upsert then
   * creates the row from), so a metadata-less one names the missing metadata
   * plainly for whoever links it by hand. Several rows is a Dodo customer two
   * organizations both claim, which must never be guessed at. The two throw from
   * distinct sites with distinct text so error tracking stops grouping them.
   * `take: 2` is what makes the several-rows case detectable.
   */
  private async resolveLinkOwner(customerId: string, subscriptionId: string): Promise<string> {
    const owners = await this.prisma.subscription.findMany({
      where: { dodoCustomerId: customerId },
      select: { organizationId: true },
      take: 2,
    });
    if (owners.length > 1) {
      throw new Error(
        `Dodo customer ${customerId} is claimed by more than one organization; ` +
          `subscription ${subscriptionId} has no unambiguous owner to link`,
      );
    }
    const owner = owners[0];
    if (!owner) {
      throw new Error(
        `Dodo customer ${customerId} has no local subscription and the activation of ` +
          `${subscriptionId} carries no organizationId metadata to create one from`,
      );
    }
    return owner.organizationId;
  }

  private async resolveSubscription(
    dodoCustomerId: string,
    dodoSubscriptionId: string | null,
  ): Promise<{ organizationId: string }> {
    const matches = await this.prisma.subscription.findMany({
      where: {
        dodoCustomerId,
        ...(dodoSubscriptionId ? { dodoSubscriptionId } : {}),
      },
      select: { organizationId: true },
      take: 2,
    });
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(
        `Dodo customer ${dodoCustomerId} did not resolve to exactly one organization`,
      );
    }
    return matches[0];
  }

  private async logBillingAuditForCustomer(
    dodoCustomerId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const sub = await this.prisma.subscription.findFirst({
      where: { dodoCustomerId },
      select: { organizationId: true },
    });
    if (!sub) return;
    await this.logBillingAudit(sub.organizationId, action, metadata);
  }

  private async logBillingAuditForSubscription(
    dodoSubscriptionId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const sub = await this.prisma.subscription.findFirst({
      where: { dodoSubscriptionId },
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
