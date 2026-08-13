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
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({ id: 'stripe-event-row' })),
    },
    subscription: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        organizationId: 'org-1',
        organization: { id: 'org-1', name: 'VoiceForge Test' },
      })),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: 'audit-1' })),
    },
    _tx: tx,
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>, event: unknown) {
  const svc = new StripeWebhookService(
    prisma as never,
    {} as never,
    { enqueue: vi.fn(async () => undefined) } as never,
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
        where: { stripeCustomerId: 'cus_123' },
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
    const prisma = makePrisma({ processedEvent: { processedAt: null, errorMessage: null } });
    const svc = makeService(prisma, makeSubscriptionEvent());

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(result.message).toContain('already being processed');
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    expect(prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('marks invoice.payment_failed subscriptions past_due and queues dunning', async () => {
    const event = {
      ...makeSubscriptionEvent('invoice.payment_failed'),
      data: { object: { customer: 'cus_123' } },
    };
    const prisma = makePrisma();
    const queue = { enqueue: vi.fn(async () => undefined) };
    const svc = new StripeWebhookService(prisma as never, {} as never, queue as never);
    Object.assign(svc as unknown as { stripe: unknown }, {
      stripe: { webhooks: { constructEvent: vi.fn(() => event) } },
    });

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_123' },
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
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { stripeSubscriptionId: 'sub_123' },
      data: { status: 'canceled' },
    });
  });

  it('marks invoice.paid subscriptions active', async () => {
    const event = {
      ...makeSubscriptionEvent('invoice.paid'),
      data: { object: { customer: 'cus_123' } },
    };
    const prisma = makePrisma();
    const svc = makeService(prisma, event);

    const result = await svc.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_123' },
      data: { status: 'active' },
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
