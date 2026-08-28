import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StripeWebhookService } from './stripe-webhook.service';
import { env } from '../config/env';

// Mirrors the shape Stripe actually delivers on api_version >= 2025-03-31.basil:
// the billing period lives on each subscription item, NOT at the top level.
function makeSubscriptionEvent(type = 'customer.subscription.created') {
  return {
    id: `evt_${type}`,
    type,
    api_version: '2026-04-22.dahlia',
    created: 1_800_000_000,
    livemode: false,
    pending_webhooks: 1,
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        cancel_at_period_end: false,
        trial_end: null,
        items: {
          data: [
            {
              price: { id: 'price_starter' },
              current_period_start: 1_800_000_000,
              current_period_end: 1_802_592_000,
            },
          ],
        },
        metadata: { organizationId: 'org-1' },
      },
    },
  };
}

function makePrisma(overrides?: {
  processedEvent?: unknown;
  transactionError?: Error;
  reclaimedCount?: number;
  subscription?: unknown;
  packGrantAudit?: unknown;
  /**
   * Full control over the grant lookup result, for cases that need something
   * other than "exactly one grant" — a payment intent that resolves to two
   * organizations cannot be expressed with `packGrantAudit`.
   */
  packGrantAudits?: unknown[];
}) {
  const uniqueError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const tx = {
    stripeEvent: {
      findUnique: vi.fn(async () => overrides?.processedEvent ?? null),
      upsert: vi.fn(async () => ({ id: 'stripe-event-row' })),
    },
  };

  return {
    $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<void>) => {
      if (overrides?.transactionError) throw overrides.transactionError;
      return cb(tx);
    }),
    stripeEvent: {
      create: vi.fn(async () => {
        if (overrides?.processedEvent) throw uniqueError;
        return { id: 'stripe-event-row' };
      }),
      findUnique: vi.fn(async () => overrides?.processedEvent ?? null),
      update: vi.fn(async () => ({ id: 'stripe-event-row' })),
      updateMany: vi.fn(async () => ({ count: overrides?.reclaimedCount ?? 1 })),
      upsert: vi.fn(async () => ({ id: 'stripe-event-row' })),
    },
    subscription: {
      update: vi.fn(async () => ({ id: 'sub-local' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      // `null` is meaningful here (no such subscription), so it must not fall
      // through to the default row the way `??` would.
      findFirst: vi.fn(async () =>
        overrides && 'subscription' in overrides
          ? overrides.subscription
          : {
              organizationId: 'org-1',
              plan: 'starter',
              organization: { id: 'org-1', name: 'VoiceForge Test' },
            },
      ),
      findMany: vi.fn(async () => {
        const subscription =
          overrides && 'subscription' in overrides
            ? overrides.subscription
            : {
                organizationId: 'org-1',
                plan: 'starter',
                organization: { id: 'org-1', name: 'VoiceForge Test' },
              };
        return subscription ? [subscription] : [];
      }),
      findUnique: vi.fn(async () =>
        overrides && 'subscription' in overrides
          ? overrides.subscription
          : {
              organizationId: 'org-1',
              plan: 'starter',
              organization: { id: 'org-1', name: 'VoiceForge Test' },
            },
      ),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: 'audit-1' })),
      findFirst: vi.fn(async () => overrides?.packGrantAudit ?? null),
      findMany: vi.fn(async () => {
        if (overrides?.packGrantAudits) return overrides.packGrantAudits;
        return overrides?.packGrantAudit ? [overrides.packGrantAudit] : [];
      }),
    },
    _tx: tx,
  };
}

function makeCreditLedger() {
  return {
    grantSubscriptionCredits: vi.fn(async () => ({ availableSeconds: 12_000 })),
    grantPurchasedCredits: vi.fn(async () => ({ availableSeconds: 18_000 })),
    reversePurchasedCredits: vi.fn(async () => ({ availableSeconds: 12_000 })),
  };
}

function makeService(
  prisma: ReturnType<typeof makePrisma>,
  event: unknown,
  deps?: {
    creditLedger?: ReturnType<typeof makeCreditLedger>;
    cacheInvalidator?: { invalidateBillingSubscription: ReturnType<typeof vi.fn> };
    queue?: { enqueue: ReturnType<typeof vi.fn> };
  },
) {
  const svc = new StripeWebhookService(
    prisma as never,
    {} as never,
    (deps?.queue ?? { enqueue: vi.fn(async () => undefined) }) as never,
    (deps?.creditLedger ?? makeCreditLedger()) as never,
    (deps?.cacheInvalidator ?? { invalidateBillingSubscription: vi.fn(async () => undefined) }) as never,
  );
  Object.assign(svc as unknown as { stripe: unknown }, {
    stripe: {
      webhooks: {
        constructEvent: vi.fn(() => event),
      },
    },
  });
  return svc;
}

describe('StripeWebhookService production webhook handling', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    Object.assign(env, {
      STRIPE_SECRET_KEY: 'rk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      STRIPE_STARTER_PRICE_ID: 'price_starter',
      STRIPE_GROWTH_PRICE_ID: 'price_growth',
      STRIPE_ENTERPRISE_PRICE_ID: 'price_enterprise',
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('returns 400 metadata for invalid signatures', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeSubscriptionEvent());
    Object.assign(svc as unknown as { stripe: unknown }, {
      stripe: {
        webhooks: {
          constructEvent: vi.fn(() => {
            throw new Error('bad signature');
          }),
        },
      },
    });

    const result = await svc.handleWebhook(Buffer.from('{}'), 'bad-signature');

    expect(result.handled).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Webhook signature verification failed'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('processes subscription.created and syncs local subscription state', async () => {
    const event = makeSubscriptionEvent('customer.subscription.created');
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        data: expect.objectContaining({
          stripeSubscriptionId: 'sub_123',
          plan: 'starter',
          status: 'active',
          currentPeriodStart: new Date(1_800_000_000 * 1000),
          currentPeriodEnd: new Date(1_802_592_000 * 1000),
        }),
      }),
    );
    expect(prisma.stripeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeEventId: event.id },
        data: expect.objectContaining({ processedAt: expect.any(Date), errorMessage: null }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-1',
          action: 'billing.subscription_synced',
          resourceType: 'subscription',
        }),
      }),
    );
  });

  it('acknowledges already processed duplicate events without dispatching again', async () => {
    const prisma = makePrisma({ processedEvent: { processedAt: new Date() } });
    const svc = makeService(prisma, makeSubscriptionEvent());

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('acknowledges duplicate events already being processed without dispatching again', async () => {
    const prisma = makePrisma({
      processedEvent: { processedAt: null, processingStartedAt: new Date() },
      reclaimedCount: 0,
    });
    const svc = makeService(prisma, makeSubscriptionEvent());

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(result.message).toContain('already being processed');
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    expect(prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  /**
   * A process that dies mid-dispatch never records an error, so ownership must
   * expire on time rather than being inferred from the absence of one.
   * Otherwise a crash permanently strands a paid event.
   */
  it('reclaims a claim whose processing lease expired and counts the attempt', async () => {
    const staleClaim = new Date(Date.now() - 10 * 60 * 1000);
    const prisma = makePrisma({
      processedEvent: { processedAt: null, processingStartedAt: staleClaim },
      reclaimedCount: 1,
    });
    const svc = makeService(prisma, makeSubscriptionEvent());

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.stripeEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingStartedAt: expect.any(Date),
          attemptCount: { increment: 1 },
        }),
      }),
    );
    expect(prisma.subscription.update).toHaveBeenCalled();
  });

  it('clears a failed event lease so the next delivery can reclaim immediately', async () => {
    const prisma = makePrisma();
    prisma.subscription.update.mockRejectedValueOnce(new Error('database unavailable'));
    const svc = makeService(prisma, makeSubscriptionEvent());

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(prisma.stripeEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ processingStartedAt: null }),
      }),
    );
  });

  it('marks invoice.payment_failed subscriptions past_due and queues dunning', async () => {
    const event = {
      ...makeSubscriptionEvent('invoice.payment_failed'),
      data: { object: { customer: 'cus_123' } },
    };
    const prisma = makePrisma();
    const queue = { enqueue: vi.fn(async () => undefined) };
    const svc = makeService(prisma, event, { queue });

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: { status: 'past_due' },
    });
    expect(queue.enqueue).toHaveBeenCalledWith('notifications', 'dunning_email', expect.objectContaining({
      organizationId: 'org-1',
      customerId: 'cus_123',
    }));
  });

  it('syncs checkout.session.completed customer and subscription ids', async () => {
    const event = {
      ...makeSubscriptionEvent('checkout.session.completed'),
      data: {
        object: {
          customer: 'cus_123',
          subscription: 'sub_123',
          metadata: { organizationId: 'org-1' },
        },
      },
    };
    const prisma = makePrisma() as ReturnType<typeof makePrisma> & {
      subscription: ReturnType<typeof makePrisma>['subscription'] & {
        upsert: ReturnType<typeof vi.fn>;
      };
    };
    prisma.subscription.upsert = vi.fn(async () => ({ id: 'sub-local' }));
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        create: expect.objectContaining({
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
          status: 'incomplete',
        }),
        update: expect.objectContaining({
          stripeCustomerId: 'cus_123',
          stripeSubscriptionId: 'sub_123',
        }),
      }),
    );
  });

  it('marks subscription.deleted rows canceled', async () => {
    const event = makeSubscriptionEvent('customer.subscription.deleted');
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: 'sub_123' },
        data: expect.objectContaining({ status: 'canceled' }),
      }),
    );
  });

  it('marks recognized invoice.paid subscriptions active', async () => {
    const event = {
      ...makeSubscriptionEvent('invoice.paid'),
      data: {
        object: {
          id: 'in_123',
          customer: 'cus_123',
          lines: {
            data: [
              {
                price: { id: 'price_starter' },
                period: { start: 1_800_000_000, end: 1_802_592_000 },
              },
            ],
          },
        },
      },
    };
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        data: expect.objectContaining({ status: 'active', plan: 'starter' }),
      }),
    );
  });

  describe('credit grants and reversals', () => {
    function makeInvoicePaidEvent(priceId = 'price_starter') {
      return {
        ...makeSubscriptionEvent('invoice.paid'),
        data: {
          object: {
            id: 'in_123',
            customer: 'cus_123',
            lines: {
              data: [
                {
                  price: { id: priceId },
                  period: { start: 1_800_000_000, end: 1_802_592_000 },
                },
              ],
            },
          },
        },
      };
    }

    function makePackCheckoutEvent(overrides?: Record<string, unknown>) {
      return {
        ...makeSubscriptionEvent('checkout.session.completed'),
        data: {
          object: {
            id: 'cs_pack_1',
            customer: 'cus_123',
            payment_status: 'paid',
            payment_intent: 'pi_pack_1',
            metadata: { organizationId: 'org-1', purchaseType: 'minute_pack' },
            ...overrides,
          },
        },
      };
    }

    it('grants included seconds once for a paid subscription invoice', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeInvoicePaidEvent(), { creditLedger });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledTimes(1);
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        invoiceId: 'in_123',
        includedMinutes: 200,
        periodEnd: new Date(1_802_592_000 * 1000),
      });
    });

    /**
     * The plan must come from our own price map. A price we never configured is
     * not evidence of a paid plan, so it must not raise entitlements.
     */
    it('fails closed for a price outside the server-owned map', async () => {
      const prisma = makePrisma({ subscription: { organizationId: 'org-1', plan: 'free' } });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeInvoicePaidEvent('price_forged_enterprise'), {
        creditLedger,
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: false, statusCode: 500 });
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
    });

    it('invalidates the cached subscription after a paid invoice', async () => {
      const cacheInvalidator = { invalidateBillingSubscription: vi.fn(async () => undefined) };
      const svc = makeService(makePrisma(), makeInvoicePaidEvent(), { cacheInvalidator });

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(cacheInvalidator.invalidateBillingSubscription).toHaveBeenCalledWith('org-1');
    });

    it('grants a minute pack for a paid pack checkout', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makePackCheckoutEvent(), { creditLedger });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', checkoutSessionId: 'cs_pack_1' }),
      );
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
    });

    it('does not grant a pack whose checkout has not been paid', async () => {
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        makePrisma(),
        makePackCheckoutEvent({ payment_status: 'unpaid' }),
        { creditLedger },
      );

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
    });

    /**
     * Checkout metadata is set when the session is created, so it cannot be the
     * only proof of ownership: without this check one organization could fund
     * another organization's balance.
     */
    it('ignores a pack event whose metadata organization does not own the Stripe customer', async () => {
      const prisma = makePrisma({ subscription: null });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makePackCheckoutEvent(), { creditLedger });

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
    });

    it('reverses pack credit after a refund of the original charge', async () => {
      const prisma = makePrisma({
        packGrantAudit: {
          organizationId: 'org-1',
          metadata: { checkoutSessionId: 'cs_pack_1', paymentIntentId: 'pi_pack_1' },
        },
      });
      const creditLedger = makeCreditLedger();
      const event = {
        ...makeSubscriptionEvent('charge.refunded'),
        data: {
          object: {
            id: 're_1',
            customer: 'cus_123',
            payment_intent: 'pi_pack_1',
            amount: 10_000,
            amount_refunded: 10_000,
          },
        },
      };
      const svc = makeService(prisma, event, { creditLedger });

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        checkoutSessionId: 'cs_pack_1',
        refundId: 're_1',
      });
    });

    /**
     * A payment intent must map to exactly one payer. If two organizations hold
     * a grant for it, reversing against either one takes credit from a customer
     * who may not have been refunded, so the event has to fail and be retried
     * after a human resolves the ambiguity.
     */
    it('refuses a reversal whose payment intent resolves to two organizations', async () => {
      const prisma = makePrisma({
        packGrantAudits: [
          {
            organizationId: 'org-1',
            metadata: { checkoutSessionId: 'cs_pack_1', paymentIntentId: 'pi_pack_1' },
          },
          {
            organizationId: 'org-2',
            metadata: { checkoutSessionId: 'cs_pack_2', paymentIntentId: 'pi_pack_1' },
          },
        ],
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        {
          ...makeSubscriptionEvent('charge.refunded'),
          data: {
            object: {
              id: 're_ambiguous',
              payment_intent: 'pi_pack_1',
              amount: 10_000,
              amount_refunded: 10_000,
            },
          },
        },
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      // A 500 keeps Stripe retrying, which is the correct outcome: the event is
      // unresolved rather than handled.
      expect(result).toMatchObject({ handled: false, statusCode: 500 });
      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
      // The ambiguity is only detectable because the query asks for one more
      // distinct owner than it expects to find.
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ distinct: ['organizationId'], take: 2 }),
      );
    });

    it('reverses a lost dispute using the recorded grant without a customer field', async () => {
      const prisma = makePrisma({
        packGrantAudit: {
          organizationId: 'org-1',
          metadata: { checkoutSessionId: 'cs_pack_1', paymentIntentId: 'pi_pack_1' },
        },
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        {
          ...makeSubscriptionEvent('charge.dispute.closed'),
          data: { object: { id: 'dp_1', payment_intent: 'pi_pack_1', status: 'lost' } },
        },
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        checkoutSessionId: 'cs_pack_1',
        refundId: 'dp_1',
      });
      expect(prisma.subscription.findMany).not.toHaveBeenCalled();
    });

    it('records a partial refund for review and acknowledges the event', async () => {
      const prisma = makePrisma({
        packGrantAudit: {
          organizationId: 'org-1',
          metadata: { checkoutSessionId: 'cs_pack_1', paymentIntentId: 'pi_pack_1' },
        },
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        {
          ...makeSubscriptionEvent('charge.refunded'),
          data: {
            object: {
              id: 're_partial',
              payment_intent: 'pi_pack_1',
              amount: 10_000,
              amount_refunded: 5_000,
            },
          },
        },
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.pack_partial_refund_review',
          }),
        }),
      );
    });

    it('reverses pack credit only when a dispute is lost', async () => {
      const prisma = makePrisma({
        packGrantAudit: {
          organizationId: 'org-1',
          metadata: { checkoutSessionId: 'cs_pack_1', paymentIntentId: 'pi_pack_1' },
        },
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        {
          ...makeSubscriptionEvent('charge.dispute.closed'),
          data: { object: { id: 'dp_1', payment_intent: 'pi_pack_1', status: 'won' } },
        },
        { creditLedger },
      );

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
    });
  });

  it('falls back to top-level period fields for pre-Basil webhook endpoints', async () => {
    const event = makeSubscriptionEvent('customer.subscription.updated');
    // Legacy endpoints pinned before 2025-03-31.basil still send the period at
    // the root and omit it from the items.
    event.data.object.items = { data: [{ price: { id: 'price_starter' } }] } as never;
    Object.assign(event.data.object, {
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
    });
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentPeriodStart: new Date(1_700_000_000 * 1000),
          currentPeriodEnd: new Date(1_702_592_000 * 1000),
        }),
      }),
    );
  });

  it('spans the widest window across mixed-interval subscription items', async () => {
    const event = makeSubscriptionEvent('customer.subscription.updated');
    event.data.object.items = {
      data: [
        {
          price: { id: 'price_starter' },
          current_period_start: 1_800_000_000,
          current_period_end: 1_802_592_000,
        },
        {
          price: { id: 'price_growth' },
          current_period_start: 1_790_000_000,
          current_period_end: 1_830_000_000,
        },
      ],
    } as never;
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentPeriodStart: new Date(1_790_000_000 * 1000),
          currentPeriodEnd: new Date(1_830_000_000 * 1000),
        }),
      }),
    );
  });

  it('persists a null period instead of failing when Stripe omits it entirely', async () => {
    const event = makeSubscriptionEvent('customer.subscription.updated');
    event.data.object.items = { data: [{ price: { id: 'price_starter' } }] } as never;
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    // Must not 500: a 500 makes Stripe retry and eventually disable the endpoint.
    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentPeriodStart: null,
          currentPeriodEnd: null,
        }),
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing a billing period'));
  });

  it('persists and acknowledges unknown events without changing billing state', async () => {
    const event = makeSubscriptionEvent('customer.discount.created');
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.stripeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeEventId: event.id,
          type: 'customer.discount.created',
        }),
      }),
    );
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Docs-vs-code drift guard.
 *
 * An operator configures the Stripe endpoint from the runbook, not from this
 * file, so a wrong event name in the runbook is a production defect with no
 * failing test anywhere: the endpoint is configured as documented, the handler
 * never fires, and nothing complains. This happened — the runbook said
 * `charge.dispute.created`, the code reverses on `charge.dispute.closed`, and
 * the gap silently left disputed minute-pack credit on the account.
 */
describe('documented Stripe webhook subscription list', () => {
  const root = ((): string => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
      if (existsSync(path.join(dir, 'docs/operations/billing-runbook.md'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error(`could not locate repo root from ${process.cwd()}`);
  })();
  // Normalized: these files are CRLF on Windows checkouts and LF in CI.
  const read = (rel: string): string =>
    readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

  /** The `case` labels of the `switch (event.type)` in `dispatch` — authoritative. */
  const handled = ((): string[] => {
    const src = read('apps/api/src/webhooks/stripe-webhook.service.ts');
    const start = src.indexOf('switch (event.type) {');
    const end = src.indexOf('default:', start);
    if (start < 0 || end < 0) throw new Error('could not locate the dispatch switch');
    return [...src.slice(start, end).matchAll(/case '([^']+)'/g)].map((m) => m[1] as string).sort();
  })();

  it('is a non-trivial set, so an empty parse cannot pass vacuously', () => {
    expect(handled.length).toBeGreaterThan(5);
  });

  it('matches the bullet list in billing-runbook.md section 1.3', () => {
    const doc = read('docs/operations/billing-runbook.md');
    const section = doc.slice(doc.indexOf('### 1.3 Webhook endpoint'));
    // Only the first contiguous run of bullets; later bullets in the section
    // are prose, not event names.
    const bullets = /(?:^- `[^`]+`\n)+/m.exec(section)?.[0] ?? '';
    const documented = [...bullets.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1] as string).sort();
    expect(documented).toEqual(handled);
  });

  it('matches the comma list in 16_BILLING.md', () => {
    const doc = read('docs/16_BILLING.md');
    const line = doc
      .slice(doc.indexOf('## Stripe Webhooks'))
      .split('\n')
      .find((l, i) => i > 0 && l.trim().length > 0);
    const documented = (line ?? '')
      .replace(/\.$/, '')
      .split(',')
      .map((s) => s.trim())
      .sort();
    expect(documented).toEqual(handled);
  });
});
