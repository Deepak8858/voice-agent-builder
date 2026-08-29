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
  /** The `included` bucket a refunded subscription invoice resolves to. */
  includedBucket?: unknown;
  /** The bucket the refunded PaymentIntent funded — the post-migration path. */
  fundedBucket?: unknown;
  /** Rows the stuck-event sweep should find still holding a processing lease. */
  stuckEvents?: unknown[];
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
      findMany: vi.fn(
        async (_input: { where: { processingStartedAt: { lte: Date } } }) =>
          overrides?.stuckEvents ?? [],
      ),
      update: vi.fn(async () => ({ id: 'stripe-event-row' })),
      updateMany: vi.fn(async () => ({ count: overrides?.reclaimedCount ?? 1 })),
      upsert: vi.fn(async () => ({ id: 'stripe-event-row' })),
    },
    billingCreditBucket: {
      findFirst: vi.fn(async () => overrides?.includedBucket ?? null),
      findUnique: vi.fn(async () => overrides?.fundedBucket ?? null),
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
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
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

  /**
   * `processing` is not an acknowledgement: it means another delivery took the
   * lease and has not finished. A 200 here tells Stripe to stop redelivering,
   * and if the lease-holder was the process that crashed, nothing is left to
   * re-drive the event once the lease expires — the grant is lost for good. So
   * this must be a 5xx that keeps the event in Stripe's retry queue.
   */
  it('asks Stripe to retry an event another delivery is still processing', async () => {
    const prisma = makePrisma({
      processedEvent: { processedAt: null, processingStartedAt: new Date() },
      reclaimedCount: 0,
    });
    const svc = makeService(prisma, makeSubscriptionEvent());

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
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
    expect(prisma.subscription.updateMany).toHaveBeenCalled();
  });

  it('clears a failed event lease so the next delivery can reclaim immediately', async () => {
    const prisma = makePrisma();
    prisma.subscription.updateMany.mockRejectedValueOnce(new Error('database unavailable'));
    const svc = makeService(prisma, makeSubscriptionEvent());

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(prisma.stripeEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ processingStartedAt: null }),
      }),
    );
  });

  /**
   * The processing lease only lets the *next delivery* reclaim a stranded row.
   * Stripe stops redelivering after a bounded window, so a process that dies
   * mid-dispatch after that window closes leaves an event `processing` forever —
   * a paid invoice or pack whose credit was never granted, with no error
   * recorded because the handler never reached one. The sweep is what re-drives
   * those.
   */
  describe('stuck event sweep', () => {
    function makeStuckRow(overrides?: Record<string, unknown>) {
      return {
        stripeEventId: 'evt_stranded',
        type: 'invoice.paid',
        apiVersion: '2026-04-22.dahlia',
        created: new Date(1_800_000_000 * 1000),
        livemode: false,
        pendingWebhooks: 1,
        processingStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        data: {
          id: 'in_stranded',
          customer: 'cus_123',
          amount_paid: 4900,
          currency: 'usd',
          lines: {
            data: [
              { price: { id: 'price_starter' }, period: { start: 1_800_000_000, end: 1_802_592_000 } },
            ],
          },
        },
        ...overrides,
      };
    }

    it('re-dispatches a stranded event from its stored payload and marks it processed', async () => {
      const prisma = makePrisma({ stuckEvents: [makeStuckRow()] });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeSubscriptionEvent(), { creditLedger });

      const recovered = await svc.reclaimStuckEvents();

      expect(recovered).toBe(1);
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: 'in_stranded', stripeEventId: 'evt_stranded' }),
      );
      expect(prisma.stripeEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripeEventId: 'evt_stranded' },
          data: expect.objectContaining({ processedAt: expect.any(Date) }),
        }),
      );
    });

    /**
     * The sweep must never take a row a live handler still owns. Its cutoff is
     * therefore far older than the processing lease that defines "still owned".
     */
    it('only considers claims far older than the processing lease', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, makeSubscriptionEvent());

      await svc.reclaimStuckEvents();

      expect(prisma.stripeEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { processedAt: null, processingStartedAt: { lte: expect.any(Date) } },
          take: 25,
        }),
      );
      const call = prisma.stripeEvent.findMany.mock.calls[0]![0];
      const cutoffAgeMs = Date.now() - call.where.processingStartedAt.lte.getTime();
      // The lease is 5 minutes; anything in that ballpark could race a handler.
      expect(cutoffAgeMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
    });

    it('leaves a row whose claim another worker holds', async () => {
      const prisma = makePrisma({
        stuckEvents: [makeStuckRow()],
        // Claim taken: the row exists and its lease is fresh, so the reclaiming
        // updateMany matches nothing.
        processedEvent: { processedAt: null, processingStartedAt: new Date() },
        reclaimedCount: 0,
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeSubscriptionEvent(), { creditLedger });

      const recovered = await svc.reclaimStuckEvents();

      expect(recovered).toBe(0);
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
    });

    it('records the failure and keeps sweeping when a re-drive throws', async () => {
      const prisma = makePrisma({
        stuckEvents: [makeStuckRow({ data: { id: 'in_stranded', customer: 'cus_123' } })],
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeSubscriptionEvent(), { creditLedger });

      const recovered = await svc.reclaimStuckEvents();

      expect(recovered).toBe(0);
      expect(prisma.stripeEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            errorMessage: expect.stringContaining('stuck-event sweep'),
          }),
        }),
      );
    });

    it('schedules the sweep on boot and stops it on shutdown', () => {
      vi.useFakeTimers();
      try {
        const prisma = makePrisma();
        const svc = makeService(prisma, makeSubscriptionEvent());
        const reclaim = vi
          .spyOn(svc, 'reclaimStuckEvents')
          .mockImplementation(async () => 0);

        svc.onModuleInit();
        vi.advanceTimersByTime(15 * 60 * 1000);
        expect(reclaim).toHaveBeenCalledTimes(1);

        svc.onModuleDestroy();
        vi.advanceTimersByTime(60 * 60 * 1000);
        expect(reclaim).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
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
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
        data: expect.objectContaining({ status: 'past_due' }),
      }),
    );
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
        where: expect.objectContaining({ stripeSubscriptionId: 'sub_123' }),
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
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
        data: expect.objectContaining({ status: 'active', plan: 'starter' }),
      }),
    );
  });

  /**
   * Stripe does not guarantee delivery order and it redelivers freely, so every
   * subscription state write is a compare-and-set against the last applied
   * event's own timestamp. Without it, a slow `subscription.updated` can
   * resurrect a canceled subscription or rewind `currentPeriodEnd`, which is what
   * `EntitlementService` now reads to decide whether a plan is still funded.
   */
  describe('out-of-order delivery', () => {
    it('stamps webhookUpdatedAt from the Stripe event, not the receive time, and gates on it', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, makeSubscriptionEvent('customer.subscription.updated'));

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      const eventCreatedAt = new Date(1_800_000_000 * 1000);
      expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          OR: [{ webhookUpdatedAt: null }, { webhookUpdatedAt: { lte: eventCreatedAt } }],
        },
        data: expect.objectContaining({ webhookUpdatedAt: eventCreatedAt }),
      });
    });

    it('skips the sync and its audit record when a newer event was already applied', async () => {
      const prisma = makePrisma();
      // No row satisfies the ordering predicate: a newer event won the race.
      prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
      const cacheInvalidator = { invalidateBillingSubscription: vi.fn(async () => undefined) };
      const svc = makeService(prisma, makeSubscriptionEvent('customer.subscription.updated'), {
        cacheInvalidator,
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      // Acknowledged: the state is already correct, so a retry would not help.
      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(cacheInvalidator.invalidateBillingSubscription).not.toHaveBeenCalled();
    });

    it('does not cancel a subscription from an event older than the state already applied', async () => {
      const prisma = makePrisma();
      prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
      const svc = makeService(prisma, makeSubscriptionEvent('customer.subscription.deleted'));

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    /**
     * An out-of-order *invoice* is different: it still paid for its own period,
     * so the credit must be granted even though the newer subscription state
     * wins. The ledger keys the grant by invoice id, so this cannot double-grant.
     */
    it('still grants included credit for an invoice whose state write was superseded', async () => {
      const prisma = makePrisma();
      prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
      const creditLedger = makeCreditLedger();
      const event = {
        ...makeSubscriptionEvent('invoice.paid'),
        data: {
          object: {
            id: 'in_123',
            customer: 'cus_123',
            amount_paid: 4900,
            currency: 'usd',
            lines: {
              data: [
                { price: { id: 'price_starter' }, period: { start: 1_800_000_000, end: 1_802_592_000 } },
              ],
            },
          },
        },
      };
      const svc = makeService(prisma, event, { creditLedger });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * A price id that is not in this deployment's configuration used to resolve to
   * `'free'` and be persisted, silently downgrading a paying customer — after
   * which the free-credit worker reads `paidAccess: false` and starts granting
   * them a monthly allowance as well. Throwing instead would leave the row stale
   * for Stripe's whole retry window, so the plan is left alone and the mismatch
   * is reported.
   */
  describe('unrecognized subscription price', () => {
    function makeUnknownPriceEvent() {
      const event = makeSubscriptionEvent('customer.subscription.updated');
      event.data.object.items = {
        data: [
          {
            price: { id: 'price_rotated_growth' },
            current_period_start: 1_800_000_000,
            current_period_end: 1_802_592_000,
          },
        ],
      } as never;
      return event;
    }

    it('does not write a plan or price it cannot recognize', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, makeUnknownPriceEvent());

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      const [args] = prisma.subscription.updateMany.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      const written = args[0].data;
      expect(written).not.toHaveProperty('plan');
      expect(written).not.toHaveProperty('stripePriceId');
      // The rest of the event is still authoritative and is applied.
      expect(written).toMatchObject({
        status: 'active',
        currentPeriodEnd: new Date(1_802_592_000 * 1000),
      });
    });

    it('reports the mismatch loudly instead of failing the event', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, makeUnknownPriceEvent());

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('price_rotated_growth'),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.subscription_price_unrecognized',
          }),
        }),
      );
    });
  });

  it('fails a cancellation that matches no local subscription so Stripe redelivers it', async () => {
    const prisma = makePrisma({ subscription: null });
    const svc = makeService(prisma, makeSubscriptionEvent('customer.subscription.deleted'));

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    // A zero-match `updateMany` used to be acknowledged as processed, leaving the
    // local row active forever with no record that anything went wrong.
    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });

  /**
   * The organization on a Checkout session comes from metadata, and a second
   * Checkout for an already-subscribed organization would overwrite the stored
   * Stripe ids. The old subscription keeps billing at Stripe while nothing here
   * can resolve it again, so its renewals stop granting credit.
   */
  describe('subscription link conflicts', () => {
    function makeCheckoutEvent(subscriptionId: string, customerId = 'cus_123') {
      return {
        ...makeSubscriptionEvent('checkout.session.completed'),
        data: {
          object: {
            id: 'cs_second',
            customer: customerId,
            subscription: subscriptionId,
            metadata: { organizationId: 'org-1' },
          },
        },
      };
    }

    function makeLinkedPrisma(linked: { stripeCustomerId: string; stripeSubscriptionId: string }) {
      const prisma = makePrisma() as ReturnType<typeof makePrisma> & {
        subscription: ReturnType<typeof makePrisma>['subscription'] & {
          upsert: ReturnType<typeof vi.fn>;
        };
      };
      prisma.subscription.upsert = vi.fn(async () => ({ id: 'sub-local' }));
      prisma.subscription.findUnique = vi.fn(async () => ({ organizationId: 'org-1', ...linked }));
      return prisma;
    }

    it('refuses to relink an organization to a different Stripe subscription', async () => {
      const prisma = makeLinkedPrisma({
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_existing',
      });
      const svc = makeService(prisma, makeCheckoutEvent('sub_second'));

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.subscription_link_conflict',
          }),
        }),
      );
    });

    it('refuses to move an organization onto a different Stripe customer', async () => {
      const prisma = makeLinkedPrisma({
        stripeCustomerId: 'cus_victim',
        stripeSubscriptionId: 'sub_existing',
      });
      const svc = makeService(prisma, makeCheckoutEvent('sub_existing', 'cus_attacker'));

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it('still links an organization that carries the same ids', async () => {
      const prisma = makeLinkedPrisma({
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_existing',
      });
      const svc = makeService(prisma, makeCheckoutEvent('sub_existing'));

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(prisma.subscription.upsert).toHaveBeenCalled();
    });
  });

  describe('credit grants and reversals', () => {
    function makeInvoicePaidEvent(priceId = 'price_starter') {
      return {
        ...makeSubscriptionEvent('invoice.paid'),
        data: {
          object: {
            id: 'in_123',
            customer: 'cus_123',
            amount_paid: 4900,
            currency: 'usd',
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
            amount_total: 3900,
            currency: 'usd',
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
        // The grant acknowledges its own event, inside its own transaction.
        stripeEventId: 'evt_invoice.paid',
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

    it('records the funding payment intent and its event on the pack grant', async () => {
      const creditLedger = makeCreditLedger();
      const svc = makeService(makePrisma(), makePackCheckoutEvent(), { creditLedger });

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(creditLedger.grantPurchasedCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: 'pi_pack_1',
          stripeEventId: 'evt_checkout.session.completed',
        }),
      );
    });

    /**
     * `payment_status: 'paid'` is true of a 100%-discounted session and of one
     * settled in another currency, neither of which paid for a pack. Nothing in
     * the repo creates a coupon today, which is the only reason this is not
     * already being exploited — one promo code in the Stripe dashboard removes
     * that accidental protection.
     */
    it.each([
      ['a fully discounted session', { amount_total: 0 }],
      ['a session settled in another currency', { currency: 'eur' }],
      ['a session with no amount at all', { amount_total: null }],
    ])('does not grant a pack for %s', async (_label, overrides) => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makePackCheckoutEvent(overrides), { creditLedger });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.grant_amount_review',
          }),
        }),
      );
    });

    it('does not grant included minutes for an invoice that collected nothing', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const event = makeInvoicePaidEvent();
      Object.assign(event.data.object, { amount_paid: 0 });
      const svc = makeService(prisma, event, { creditLedger });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'billing.grant_amount_review' }),
        }),
      );
    });

    /**
     * A refunded subscription charge names its invoice, which is the `sourceId`
     * the period's included bucket was granted under. This path did not exist:
     * every subscription refund fell through to the pack lookup, found nothing,
     * threw, and 500-looped — so refunded subscription revenue stayed on the
     * account as usable minutes.
     */
    it('reverses included credit for a refunded subscription invoice', async () => {
      const prisma = makePrisma({ includedBucket: { organizationId: 'org-1' } });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        {
          ...makeSubscriptionEvent('charge.refunded'),
          data: {
            object: {
              id: 're_sub',
              customer: 'cus_123',
              invoice: 'in_123',
              payment_intent: 'pi_sub',
              amount: 4900,
              amount_refunded: 4900,
            },
          },
        },
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        checkoutSessionId: 'in_123',
        refundId: 're_sub',
        sourceType: 'included',
      });
      // Resolved from the bucket, so the legacy audit-log lookup is not needed.
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('records an invoice refund with no matching included credit for review', async () => {
      const prisma = makePrisma({ includedBucket: null });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        {
          ...makeSubscriptionEvent('charge.refunded'),
          data: {
            object: {
              id: 're_orphan',
              customer: 'cus_123',
              invoice: 'in_missing',
              amount: 4900,
              amount_refunded: 4900,
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
            action: 'billing.credit_reversal_unresolved',
            metadata: expect.objectContaining({ reason: 'no_included_credit_for_invoice' }),
          }),
        }),
      );
    });

    /**
     * A dispute payload carries no customer, so the payment intent recorded on
     * the bucket is the only durable mapping back to the payer.
     */
    it('reverses a dispute through the payment intent recorded on the bucket', async () => {
      const prisma = makePrisma({
        fundedBucket: {
          organizationId: 'org-1',
          sourceType: 'purchased',
          sourceId: 'cs_pack_1',
        },
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        {
          ...makeSubscriptionEvent('charge.dispute.closed'),
          data: { object: { id: 'dp_pi', payment_intent: 'pi_pack_1', status: 'lost' } },
        },
        { creditLedger },
      );

      await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(prisma.billingCreditBucket.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { stripePaymentIntentId: 'pi_pack_1' } }),
      );
      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        checkoutSessionId: 'cs_pack_1',
        refundId: 'dp_pi',
        sourceType: 'purchased',
      });
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    /**
     * `unpaid` means a delayed-notification method is still clearing. Nothing
     * grants it later — the pack Checkout is card-only precisely because of that
     * — so a session that reaches here unpaid is a customer who may have paid and
     * received nothing. It must leave a record a human can act on rather than a
     * warn line.
     */
    it('records an unpaid pack checkout for manual review instead of dropping it', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makePackCheckoutEvent({ payment_status: 'unpaid' }), {
        creditLedger,
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.pack_checkout_unpaid_review',
          }),
        }),
      );
    });

    it('does not grant a pack whose checkout requires no payment', async () => {
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        makePrisma(),
        makePackCheckoutEvent({ payment_status: 'no_payment_required' }),
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
        sourceType: 'purchased',
      });
    });

    /**
     * A payment intent must map to exactly one payer. If two organizations hold
     * a grant for it, reversing against either takes credit from a customer who
     * may not have been refunded, so nothing is reversed. Retrying forever does
     * not resolve it either — it just 500-loops until Stripe gives up and the
     * refund is forgotten — so the ambiguity is written where a human sees it
     * and the event terminates.
     */
    it('records an ambiguous payment intent for review instead of retrying forever', async () => {
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
              customer: 'cus_123',
              payment_intent: 'pi_pack_1',
              amount: 10_000,
              amount_refunded: 10_000,
            },
          },
        },
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
      // The ambiguity is only detectable because the query asks for one more
      // distinct owner than it expects to find.
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ distinct: ['organizationId'], take: 2 }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.credit_reversal_unresolved',
            metadata: expect.objectContaining({ reason: 'ambiguous_payment_intent' }),
          }),
        }),
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
        sourceType: 'purchased',
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
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
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
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
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
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
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
