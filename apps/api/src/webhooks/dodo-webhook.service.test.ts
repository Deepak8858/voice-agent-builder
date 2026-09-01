import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DodoWebhookService } from './dodo-webhook.service';
import { env } from '../config/env';

const WEBHOOK_SECRET = `whsec_${Buffer.from('dodo-test-signing-key').toString('base64')}`;
const EVENT_AT = '2027-01-15T00:00:00.000Z';
const PERIOD_END = '2027-02-15T00:00:00.000Z';

const HEADERS = { webhookId: 'wh_1', signature: 'v1,sig', timestamp: '1800000000' };

/** The Dodo envelope: `{ business_id, type, timestamp, data }`. */
function makeEvent(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { business_id: 'biz_1', type, timestamp: EVENT_AT, data };
}

function subscriptionData(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    subscription_id: 'sub_123',
    customer: { customer_id: 'cus_123', email: 'owner@example.com', name: 'Org One' },
    product_id: 'prod_starter',
    status: 'active',
    cancel_at_next_billing_date: false,
    previous_billing_date: EVENT_AT,
    next_billing_date: PERIOD_END,
    recurring_pre_tax_amount: 4900,
    currency: 'USD',
    metadata: { organizationId: 'org-1' },
    ...overrides,
  };
}

function packPaymentData(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    payment_id: 'pay_pack_1',
    status: 'succeeded',
    total_amount: 3900,
    currency: 'USD',
    customer: { customer_id: 'cus_123', email: 'owner@example.com', name: 'Org One' },
    product_cart: [{ product_id: 'prod_minute_pack', quantity: 1 }],
    metadata: { organizationId: 'org-1', purchaseType: 'minute_pack' },
    ...overrides,
  };
}

const DEFAULT_SUB = {
  organizationId: 'org-1',
  plan: 'starter',
  organization: { id: 'org-1', name: 'VoiceForge Test' },
};

type SubscriptionRow = Record<string, unknown> | null;

function makePrisma(overrides?: {
  processedEvent?: unknown;
  reclaimedCount?: number;
  subscription?: SubscriptionRow;
  /** Overrides only the `findFirst` used to detect a foreign customer owner. */
  foreignOwner?: SubscriptionRow;
  /** The bucket the reversed payment funded. */
  fundedBucket?: unknown;
  /**
   * `included` buckets whose cycle covers the refunded payment — the rows the
   * `sourceId startsWith 'sub:<id>:'` + `expiresAt > paidAt` query returns.
   */
  cycleBuckets?: Array<{ sourceId: string }>;
  /** Rows the stuck-event sweep should find still holding a processing lease. */
  stuckEvents?: unknown[];
  /**
   * Makes `dodo_webhook_events` behave like the real table across two deliveries
   * of the same event: the second `create` collides on the unique index, and once
   * `markProcessed` has run the row reports itself processed. Without this the
   * mock is stateless, so a second `handleWebhook` sails past the claim and a
   * replay test would silently prove nothing.
   */
  replayable?: boolean;
}) {
  const uniqueError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  let claimed = false;
  let processed = false;
  const subRow = (): SubscriptionRow =>
    overrides && 'subscription' in overrides ? (overrides.subscription ?? null) : DEFAULT_SUB;

  return {
    dodoWebhookEvent: {
      create: vi.fn(async () => {
        if (overrides?.processedEvent) throw uniqueError;
        if (overrides?.replayable && claimed) throw uniqueError;
        claimed = true;
        return { id: 'dodo-event-row' };
      }),
      findUnique: vi.fn(async () =>
        overrides?.replayable && processed
          ? { processedAt: new Date() }
          : (overrides?.processedEvent ?? null),
      ),
      findMany: vi.fn(
        async (_input: { where: { processingStartedAt: { lte: Date } } }) =>
          overrides?.stuckEvents ?? [],
      ),
      update: vi.fn(async () => {
        processed = true;
        return { id: 'dodo-event-row' };
      }),
      updateMany: vi.fn(async () => ({ count: overrides?.reclaimedCount ?? 1 })),
      // Typed so a test can read back the failure write and check the row it
      // leaves behind, not just that some upsert happened.
      upsert: vi.fn(async (_input: { update: Record<string, unknown> }) => ({
        id: 'dodo-event-row',
      })),
    },
    billingCreditBucket: {
      findUnique: vi.fn(async () => overrides?.fundedBucket ?? null),
      // `take: 2` in the real query is what makes "more than one" detectable, so
      // the stub honours it rather than returning the whole fixture.
      findMany: vi.fn(async (input?: { take?: number }) =>
        (overrides?.cycleBuckets ?? []).slice(0, input?.take ?? Infinity),
      ),
    },
    subscription: {
      update: vi.fn(async () => ({ id: 'sub-local' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({ id: 'sub-local' })),
      // Honours `organizationId: { not }` so the foreign-owner probe behaves like
      // the real query: the organization being linked is excluded from it, and a
      // stub that ignored the predicate would report every link as a conflict.
      findFirst: vi.fn(async (input?: { where?: Record<string, unknown> }) => {
        const excluded = (input?.where?.['organizationId'] as { not?: string } | undefined)?.not;
        if (excluded !== undefined) {
          if (overrides && 'foreignOwner' in overrides) return overrides.foreignOwner ?? null;
          const row = subRow();
          return row && row['organizationId'] === excluded ? null : row;
        }
        return subRow();
      }),
      findMany: vi.fn(async () => {
        const row = subRow();
        return row ? [row] : [];
      }),
      findUnique: vi.fn(async () => subRow()),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: 'audit-1' })),
    },
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
    /** Replaces the SDK verifier; omit to keep the real Standard Webhooks one. */
    unwrap?: ReturnType<typeof vi.fn>;
    /**
     * Replaces `payments.retrieve`. Always stubbed, because the constructor builds
     * a real client from `setEnv`'s key and an unstubbed retrieve would put a live
     * HTTP call inside the reversal tests. The default answers "one-off payment,
     * no subscription", which is the pre-existing behaviour for a pack refund.
     */
    retrievePayment?: ReturnType<typeof vi.fn>;
  },
) {
  const svc = new DodoWebhookService(
    prisma as never,
    (deps?.creditLedger ?? makeCreditLedger()) as never,
    (deps?.cacheInvalidator ?? {
      invalidateBillingSubscription: vi.fn(async () => undefined),
    }) as never,
  );
  if (!deps || !('unwrap' in deps) || deps.unwrap) {
    Object.assign(svc as unknown as { webhooks: unknown }, {
      webhooks: { unwrap: deps?.unwrap ?? vi.fn(() => event) },
    });
  }
  Object.assign(svc as unknown as { payments: unknown }, {
    payments: {
      retrieve:
        deps?.retrievePayment ??
        vi.fn(async () => ({
          payment_id: 'pay_pack_1',
          subscription_id: null,
          customer: { customer_id: 'cus_123' },
          created_at: EVENT_AT,
        })),
    },
  });
  return svc;
}

function setEnv(): void {
  Object.assign(env, {
    DODO_PAYMENTS_API_KEY: 'dodo_test_123',
    DODO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DODO_PAYMENTS_ENVIRONMENT: 'test_mode',
    DODO_STARTER_PRODUCT_ID: 'prod_starter',
    DODO_GROWTH_PRODUCT_ID: 'prod_growth',
    DODO_ENTERPRISE_PRODUCT_ID: 'prod_enterprise',
    DODO_MINUTE_PACK_PRODUCT_ID: 'prod_minute_pack',
  });
}

describe('DodoWebhookService production webhook handling', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    setEnv();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /**
   * The whole point of Standard Webhooks: the signed string is
   * `${webhook-id}.${webhook-timestamp}.${raw body}`, HMAC-SHA256 under the
   * base64-decoded secret. Signing a payload here with a known secret and handing
   * it to the *real* verifier proves the endpoint accepts a genuine delivery, and
   * flipping one byte of the body proves it rejects a forged one before it reads
   * or writes anything.
   */
  describe('Standard Webhooks signature verification', () => {
    function sign(body: string, webhookId: string, timestamp: string): string {
      const key = Buffer.from(WEBHOOK_SECRET.slice('whsec_'.length), 'base64');
      const digest = createHmac('sha256', key)
        .update(`${webhookId}.${timestamp}.${body}`)
        .digest('base64');
      return `v1,${digest}`;
    }

    function signedDelivery(body: string): {
      payload: Buffer;
      headers: { webhookId: string; signature: string; timestamp: string };
    } {
      const webhookId = 'wh_signed_1';
      // Inside the spec's five-minute tolerance, measured from now.
      const timestamp = String(Math.floor(Date.now() / 1000));
      return {
        payload: Buffer.from(body, 'utf8'),
        headers: { webhookId, signature: sign(body, webhookId, timestamp), timestamp },
      };
    }

    const body = JSON.stringify(
      makeEvent('subscription.renewed', subscriptionData()),
    );

    it('accepts a correctly signed delivery', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, null, { unwrap: undefined });
      const { payload, headers } = signedDelivery(body);

      const result = await svc.handleWebhook(payload, headers);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.dodoWebhookEvent.create).toHaveBeenCalled();
    });

    it('rejects a tampered body before touching the database', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, null, { unwrap: undefined });
      const { headers } = signedDelivery(body);

      const result = await svc.handleWebhook(
        Buffer.from(body.replace('4900', '1'), 'utf8'),
        headers,
      );

      expect(result).toMatchObject({ handled: false, statusCode: 400 });
      expect(prisma.dodoWebhookEvent.create).not.toHaveBeenCalled();
      expect(prisma.dodoWebhookEvent.upsert).not.toHaveBeenCalled();
    });

    it('rejects a delivery whose timestamp is outside the tolerance window', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, null, { unwrap: undefined });
      const stale = String(Math.floor(Date.now() / 1000) - 60 * 60);

      const result = await svc.handleWebhook(Buffer.from(body, 'utf8'), {
        webhookId: 'wh_signed_1',
        signature: sign(body, 'wh_signed_1', stale),
        timestamp: stale,
      });

      expect(result).toMatchObject({ handled: false, statusCode: 400 });
      expect(prisma.dodoWebhookEvent.create).not.toHaveBeenCalled();
    });

    it('rejects a delivery with no signature header at all', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, null, { unwrap: undefined });

      const result = await svc.handleWebhook(Buffer.from(body, 'utf8'), {
        webhookId: 'wh_signed_1',
        signature: '',
        timestamp: String(Math.floor(Date.now() / 1000)),
      });

      expect(result).toMatchObject({ handled: false, statusCode: 400 });
      expect(prisma.dodoWebhookEvent.create).not.toHaveBeenCalled();
    });
  });

  it('returns 400 metadata for invalid signatures', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, null, {
      unwrap: vi.fn(() => {
        throw new Error('No matching signature found');
      }),
    });

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result.handled).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(prisma.dodoWebhookEvent.create).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Webhook signature verification failed'),
    );
  });

  it('fails closed when no webhook secret is configured', async () => {
    Object.assign(env, { DODO_WEBHOOK_SECRET: undefined });
    const prisma = makePrisma();
    const svc = new DodoWebhookService(prisma as never, makeCreditLedger() as never);

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(prisma.dodoWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('processes subscription.active and syncs local subscription state', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeEvent('subscription.active', subscriptionData()));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
        data: expect.objectContaining({
          dodoSubscriptionId: 'sub_123',
          dodoCustomerId: 'cus_123',
          dodoProductId: 'prod_starter',
          plan: 'starter',
          status: 'active',
          currentPeriodStart: new Date(EVENT_AT),
          currentPeriodEnd: new Date(PERIOD_END),
        }),
      }),
    );
    expect(prisma.dodoWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { webhookId: 'wh_1' },
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

  it('links the customer and subscription ids on first activation', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeEvent('subscription.active', subscriptionData()));

    await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(prisma.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        create: expect.objectContaining({
          dodoCustomerId: 'cus_123',
          dodoSubscriptionId: 'sub_123',
          status: 'incomplete',
        }),
        update: expect.objectContaining({
          dodoCustomerId: 'cus_123',
          dodoSubscriptionId: 'sub_123',
        }),
      }),
    );
  });

  /**
   * The activation payload's metadata travels through the customer's browser
   * session, so it cannot be the only route to the organization. Without metadata
   * the customer -> organization mapping written before checkout is used instead,
   * and it is entirely server-owned.
   */
  it('resolves the organization from the stored customer when metadata carries none', async () => {
    const prisma = makePrisma();
    const svc = makeService(
      prisma,
      makeEvent('subscription.active', subscriptionData({ metadata: {} })),
    );

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dodoCustomerId: 'cus_123' } }),
    );
    expect(prisma.subscription.upsert).toHaveBeenCalled();
  });

  /**
   * A subscription created straight in the Dodo dashboard has no local row, and a
   * metadata-less activation of it names no organization to build one from. The
   * old fallback threw the same "not exactly one" error the several-rows case
   * threw, so the two grouped together. The failure now names the missing metadata
   * so it is fixed by hand, and throws from its own site so error tracking keeps it
   * apart from the ambiguous case.
   */
  it('fails distinctly when neither a local row nor metadata resolves the organization', async () => {
    const prisma = makePrisma({ subscription: null });
    const svc = makeService(
      prisma,
      makeEvent('subscription.active', subscriptionData({ metadata: {} })),
    );

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    expect(prisma.dodoWebhookEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          errorMessage: expect.stringContaining('no organizationId metadata'),
        }),
      }),
    );
  });

  /**
   * Two organizations claiming one Dodo customer is genuinely ambiguous: linking
   * either way could grant one payer's renewals to the other's balance. It stays a
   * hard failure, but a distinct one that no longer shares a message or a throw
   * site with the no-row case.
   */
  it('fails distinctly when the customer is claimed by more than one organization', async () => {
    const prisma = makePrisma();
    prisma.subscription.findMany = vi.fn(async () => [
      { organizationId: 'org-1' },
      { organizationId: 'org-2' },
    ]);
    const svc = makeService(
      prisma,
      makeEvent('subscription.active', subscriptionData({ metadata: {} })),
    );

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    expect(prisma.dodoWebhookEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          errorMessage: expect.stringContaining('more than one organization'),
        }),
      }),
    );
  });

  it('acknowledges already processed duplicate events without dispatching again', async () => {
    const prisma = makePrisma({ processedEvent: { processedAt: new Date() } });
    const svc = makeService(prisma, makeEvent('subscription.renewed', subscriptionData()));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });

  /**
   * `processing` is not an acknowledgement: it means another delivery took the
   * lease and has not finished. A 200 here tells Dodo to stop redelivering, and if
   * the lease-holder was the process that crashed, nothing is left to re-drive the
   * event once the lease expires — the grant is lost for good. So this must be a
   * 5xx that keeps the event in Dodo's retry queue.
   */
  it('asks Dodo to retry an event another delivery is still processing', async () => {
    const prisma = makePrisma({
      processedEvent: { processedAt: null, processingStartedAt: new Date() },
      reclaimedCount: 0,
    });
    const svc = makeService(prisma, makeEvent('subscription.renewed', subscriptionData()));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(result.message).toContain('already being processed');
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    expect(prisma.dodoWebhookEvent.update).not.toHaveBeenCalled();
  });

  /**
   * A process that dies mid-dispatch never records an error, so ownership must
   * expire on time rather than being inferred from the absence of one. Otherwise a
   * crash permanently strands a paid event.
   */
  it('reclaims a claim whose processing lease expired and counts the attempt', async () => {
    const staleClaim = new Date(Date.now() - 10 * 60 * 1000);
    const prisma = makePrisma({
      processedEvent: { processedAt: null, processingStartedAt: staleClaim },
      reclaimedCount: 1,
    });
    const svc = makeService(prisma, makeEvent('subscription.renewed', subscriptionData()));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.dodoWebhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingStartedAt: expect.any(Date),
          attemptCount: { increment: 1 },
        }),
      }),
    );
    expect(prisma.subscription.updateMany).toHaveBeenCalled();
  });

  /**
   * Clearing the lease on failure also hid the row from the stuck-event sweep,
   * whose predicate ages rows by `processingStartedAt` and so can never match
   * `null`: once the provider's retry window closed on a failing event, nothing
   * swept it again and the billing state change was lost. Keeping the claim
   * timestamp costs at most one wasted redelivery and buys the row a place in
   * every later sweep.
   */
  it('keeps the failed attempt lease so the stuck-event sweep can still see the row', async () => {
    const prisma = makePrisma();
    prisma.subscription.updateMany.mockRejectedValueOnce(new Error('database unavailable'));
    const svc = makeService(prisma, makeEvent('subscription.renewed', subscriptionData()));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    // Exact, not `objectContaining`: a reintroduced `processingStartedAt: null`
    // must fail here.
    expect(prisma.dodoWebhookEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { errorMessage: expect.any(String) } }),
    );
  });

  /**
   * The processing lease only lets the *next delivery* reclaim a stranded row.
   * Dodo stops redelivering after a bounded window, so a process that dies
   * mid-dispatch after that window closes leaves an event `processing` forever — a
   * paid renewal or pack whose credit was never granted, with no error recorded
   * because the handler never reached one. The sweep is what re-drives those.
   */
  describe('stuck event sweep', () => {
    function makeStuckRow(overrides?: Record<string, unknown>) {
      return {
        webhookId: 'wh_stranded',
        type: 'subscription.renewed',
        apiVersion: null,
        created: new Date(EVENT_AT),
        livemode: false,
        pendingWebhooks: 0,
        processingStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        data: subscriptionData(),
        ...overrides,
      };
    }

    it('re-dispatches a stranded event from its stored payload and marks it processed', async () => {
      const prisma = makePrisma({ stuckEvents: [makeStuckRow()] });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, null, { creditLedger });

      const recovered = await svc.reclaimStuckEvents();

      expect(recovered).toBe(1);
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: `sub:sub_123:${EVENT_AT}`,
          webhookId: 'wh_stranded',
        }),
      );
      expect(prisma.dodoWebhookEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { webhookId: 'wh_stranded' },
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
      const svc = makeService(prisma, null);

      await svc.reclaimStuckEvents();

      expect(prisma.dodoWebhookEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { processedAt: null, processingStartedAt: { lte: expect.any(Date) } },
          take: 25,
        }),
      );
      const call = prisma.dodoWebhookEvent.findMany.mock.calls[0]![0];
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
      const svc = makeService(prisma, null, { creditLedger });

      const recovered = await svc.reclaimStuckEvents();

      expect(recovered).toBe(0);
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
    });

    it('records the failure and keeps sweeping when a re-drive throws', async () => {
      const prisma = makePrisma({
        stuckEvents: [makeStuckRow({ data: { subscription_id: 'sub_123' } })],
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, null, { creditLedger });

      const recovered = await svc.reclaimStuckEvents();

      expect(recovered).toBe(0);
      expect(prisma.dodoWebhookEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            errorMessage: expect.stringContaining('stuck-event sweep'),
          }),
        }),
      );
    });

    /**
     * A re-drive that fails must stay sweepable. The sweep ages rows by
     * `processingStartedAt`, so if the failure write cleared that column the row
     * would drop out of every later pass — one failed re-drive and the event is
     * stranded for good. Applying the actual failure write to the row and
     * re-checking it against the sweep's own predicate is what proves it.
     */
    it('leaves an errored row still matching the sweep predicate for a later pass', async () => {
      const row = makeStuckRow({ data: { subscription_id: 'sub_123' } });
      const prisma = makePrisma({ stuckEvents: [row] });
      const svc = makeService(prisma, null, { creditLedger: makeCreditLedger() });

      expect(await svc.reclaimStuckEvents()).toBe(0);

      const predicate = prisma.dodoWebhookEvent.findMany.mock.calls[0]![0].where;
      expect(predicate).toEqual({
        processedAt: null,
        processingStartedAt: { lte: expect.any(Date) },
      });
      const failureWrite = prisma.dodoWebhookEvent.upsert.mock.calls[0]![0].update;
      // The claim this pass took, with the recorded failure applied on top.
      const claimedAt = new Date();
      const after = { ...row, processedAt: null, processingStartedAt: claimedAt, ...failureWrite };
      // The sweep predicate, evaluated on a pass an hour after this attempt.
      const laterCutoff = new Date(claimedAt.getTime() + 60 * 60 * 1000);
      expect(
        after.processedAt === null &&
          after.processingStartedAt !== null &&
          after.processingStartedAt <= laterCutoff,
      ).toBe(true);
    });

    it('schedules the sweep on boot and stops it on shutdown', () => {
      vi.useFakeTimers();
      try {
        const prisma = makePrisma();
        const svc = makeService(prisma, null);
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

  /**
   * Dunning must stop paid usage without pretending the subscription is gone, and
   * it must not enqueue a notification job: `'notifications'` is a queue no worker
   * consumes, so the enqueue that used to be here left a job in Redis forever
   * while the log claimed an email had been sent.
   */
  it.each([
    ['subscription.on_hold', 'past_due'],
    ['subscription.failed', 'unpaid'],
  ])('marks %s subscriptions %s and enqueues nothing', async (type, status) => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeEvent(type, subscriptionData({ status: 'on_hold' })));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
        data: expect.objectContaining({ status }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'billing.payment_failed' }),
      }),
    );
  });

  it.each(['subscription.cancelled', 'subscription.expired'])(
    'marks %s rows canceled and drops the plan back to free',
    async (type) => {
      const prisma = makePrisma();
      const svc = makeService(prisma, makeEvent(type, subscriptionData({ status: 'cancelled' })));

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ dodoSubscriptionId: 'sub_123' }),
          data: expect.objectContaining({ status: 'canceled', plan: 'free' }),
        }),
      );
    },
  );

  it('fails a cancellation that matches no local subscription so Dodo redelivers it', async () => {
    const prisma = makePrisma({ subscription: null });
    const svc = makeService(prisma, makeEvent('subscription.cancelled', subscriptionData()));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    // A zero-match `updateMany` used to be acknowledged as processed, leaving the
    // local row active forever with no record that anything went wrong.
    expect(result).toMatchObject({ handled: false, statusCode: 500 });
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('resolves a renewal by customer and subscription id together', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeEvent('subscription.renewed', subscriptionData()));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dodoCustomerId: 'cus_123', dodoSubscriptionId: 'sub_123' },
      }),
    );
  });

  /**
   * Dodo does not guarantee delivery order and it redelivers freely, so every
   * subscription state write is a compare-and-set against the last applied
   * event's own timestamp. Without it, a slow event can resurrect a canceled
   * subscription or rewind `currentPeriodEnd`, which is what `EntitlementService`
   * reads to decide whether a plan is still funded.
   */
  describe('out-of-order delivery', () => {
    it('stamps webhookUpdatedAt from the Dodo event, not the receive time, and gates on it', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, makeEvent('subscription.plan_changed', subscriptionData()));

      await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      const eventCreatedAt = new Date(EVENT_AT);
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
      const svc = makeService(prisma, makeEvent('subscription.plan_changed', subscriptionData()), {
        cacheInvalidator,
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      // Acknowledged: the state is already correct, so a retry would not help.
      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(cacheInvalidator.invalidateBillingSubscription).not.toHaveBeenCalled();
    });

    it('does not cancel a subscription from an event older than the state already applied', async () => {
      const prisma = makePrisma();
      prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
      const svc = makeService(prisma, makeEvent('subscription.cancelled', subscriptionData()));

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    /**
     * An out-of-order *cycle* event is different: it still paid for its own
     * period, so the credit must be granted even though the newer subscription
     * state wins. The ledger keys the grant by cycle, so this cannot double-grant.
     */
    it('still grants included credit for a cycle whose state write was superseded', async () => {
      const prisma = makePrisma();
      prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeEvent('subscription.renewed', subscriptionData()), {
        creditLedger,
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * A product id that is not in this deployment's configuration used to resolve to
   * `'free'` and be persisted, silently downgrading a paying customer — after
   * which the free-credit worker reads `paidAccess: false` and starts granting them
   * a monthly allowance as well. Throwing instead would leave the row stale for
   * Dodo's whole retry window, so on a plan change the plan is left alone and the
   * mismatch is reported.
   */
  describe('unrecognized subscription product', () => {
    const unknownProduct = () =>
      makeEvent('subscription.plan_changed', subscriptionData({ product_id: 'prod_rotated' }));

    it('does not write a plan or product it cannot recognize', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, unknownProduct());

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      const [args] = prisma.subscription.updateMany.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      const written = args[0].data;
      expect(written).not.toHaveProperty('plan');
      expect(written).not.toHaveProperty('dodoProductId');
      // The rest of the event is still authoritative and is applied.
      expect(written).toMatchObject({
        status: 'active',
        currentPeriodEnd: new Date(PERIOD_END),
      });
    });

    it('reports the mismatch loudly instead of failing the event', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma, unknownProduct());

      await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('prod_rotated'));
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.subscription_product_unrecognized',
          }),
        }),
      );
    });

    /**
     * A cycle event is the money path: an unrecognized product there is not
     * evidence of a paid plan, so it must not raise entitlements or grant.
     */
    it('fails closed on a cycle event for a product outside the server-owned map', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('subscription.renewed', subscriptionData({ product_id: 'prod_forged' })),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: false, statusCode: 500 });
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
    });
  });

  /**
   * An unknown status must not be guessed at. Mapping it to `active` would fund
   * usage on a state nobody reviewed; mapping it to a dead status would cut off a
   * paying customer. It is left untouched and reported.
   */
  it('leaves the stored status untouched for a Dodo status it does not know', async () => {
    const prisma = makePrisma();
    const svc = makeService(
      prisma,
      makeEvent('subscription.plan_changed', subscriptionData({ status: 'quantum_limbo' })),
    );

    await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    const [args] = prisma.subscription.updateMany.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    // No `status` in the write at all: the update leaves the stored, reviewed
    // status in place. The old assertion pinned `?? 'active'` — which funded
    // usage on a state nobody reviewed, the exact thing the docblock forbids.
    expect(args[0].data).not.toHaveProperty('status');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('quantum_limbo'));
  });

  /**
   * The activation payload names the organization in metadata, and a second
   * activation for an already-subscribed organization would overwrite the stored
   * Dodo ids. The old subscription keeps billing while nothing here can resolve it
   * again, so its renewals stop granting credit.
   */
  describe('subscription link conflicts', () => {
    function makeLinkedPrisma(linked: {
      dodoCustomerId: string;
      dodoSubscriptionId: string;
    }) {
      const prisma = makePrisma({ foreignOwner: null });
      prisma.subscription.findUnique = vi.fn(async () => ({
        organizationId: 'org-1',
        ...linked,
      }));
      return prisma;
    }

    it('refuses to relink an organization to a different Dodo subscription', async () => {
      const prisma = makeLinkedPrisma({
        dodoCustomerId: 'cus_123',
        dodoSubscriptionId: 'sub_existing',
      });
      const svc = makeService(
        prisma,
        makeEvent('subscription.active', subscriptionData({ subscription_id: 'sub_second' })),
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

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

    it('refuses to move an organization onto a different Dodo customer', async () => {
      const prisma = makeLinkedPrisma({
        dodoCustomerId: 'cus_victim',
        dodoSubscriptionId: 'sub_123',
      });
      const svc = makeService(
        prisma,
        makeEvent(
          'subscription.active',
          subscriptionData({ customer: { customer_id: 'cus_attacker' } }),
        ),
      );

      await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    /**
     * The metadata organization is not proof of ownership. When the named
     * organization had no `dodoCustomerId` yet, the conflict check fell through and
     * the PAYING customer's id was written onto that organization's row: from then
     * on the payer's renewals granted credit to a balance that was not theirs. A
     * customer already held by another organization is refused.
     */
    it('refuses to link a customer another organization already holds', async () => {
      const prisma = makePrisma({ foreignOwner: { organizationId: 'org-attacker' } });
      // The victim organization has no subscription row at all yet.
      prisma.subscription.findUnique = vi.fn(async () => null);
      const svc = makeService(
        prisma,
        makeEvent(
          'subscription.active',
          subscriptionData({
            subscription_id: 'sub_attacker',
            customer: { customer_id: 'cus_attacker' },
            metadata: { organizationId: 'org-victim' },
          }),
        ),
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
      // Organization-scoped, so the ownership check is not a cross-tenant scan.
      expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { dodoCustomerId: 'cus_attacker', organizationId: { not: 'org-victim' } },
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.subscription_link_conflict',
            metadata: expect.objectContaining({
              field: 'dodoCustomerId',
              current: 'held by organization org-attacker',
            }),
          }),
        }),
      );
    });

    it('still links an organization that carries the same ids', async () => {
      const prisma = makeLinkedPrisma({
        dodoCustomerId: 'cus_123',
        dodoSubscriptionId: 'sub_123',
      });
      const svc = makeService(prisma, makeEvent('subscription.active', subscriptionData()));

      await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(prisma.subscription.upsert).toHaveBeenCalled();
    });
  });

  describe('credit grants and reversals', () => {
    it('grants included seconds once for a funded billing cycle', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeEvent('subscription.renewed', subscriptionData()), {
        creditLedger,
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledTimes(1);
      expect(creditLedger.grantSubscriptionCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        // Dodo's subscription payloads carry no payment id, so one cycle is
        // identified by the subscription plus the boundary it started at.
        paymentId: `sub:sub_123:${EVENT_AT}`,
        includedMinutes: 200,
        periodEnd: new Date(PERIOD_END),
        // The grant acknowledges its own delivery, inside its own transaction.
        webhookId: 'wh_1',
      });
    });

    /**
     * `subscription.active` and `subscription.renewed` for the same cycle derive
     * the same grant key, so the ledger refuses the second one. A per-event-type
     * key would have granted twice for the first period.
     */
    it('derives the same grant key for activation and renewal of one cycle', async () => {
      const activation = makeCreditLedger();
      const renewal = makeCreditLedger();
      await makeService(makePrisma(), makeEvent('subscription.active', subscriptionData()), {
        creditLedger: activation,
      }).handleWebhook(Buffer.from('{}'), HEADERS);
      await makeService(makePrisma(), makeEvent('subscription.renewed', subscriptionData()), {
        creditLedger: renewal,
      }).handleWebhook(Buffer.from('{}'), HEADERS);

      const sameKey = expect.objectContaining({ paymentId: `sub:sub_123:${EVENT_AT}` });
      expect(activation.grantSubscriptionCredits).toHaveBeenCalledWith(sameKey);
      expect(renewal.grantSubscriptionCredits).toHaveBeenCalledWith(sameKey);
    });

    it('invalidates the cached subscription after a funded cycle', async () => {
      const cacheInvalidator = { invalidateBillingSubscription: vi.fn(async () => undefined) };
      const svc = makeService(
        makePrisma(),
        makeEvent('subscription.renewed', subscriptionData()),
        { cacheInvalidator },
      );

      await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(cacheInvalidator.invalidateBillingSubscription).toHaveBeenCalledWith('org-1');
    });

    it('grants a minute pack for a succeeded one-time payment', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeEvent('payment.succeeded', packPaymentData()), {
        creditLedger,
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        paymentId: 'pay_pack_1',
        purchasedAt: new Date(EVENT_AT),
        webhookId: 'wh_1',
      });
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
    });

    /**
     * The no-double-grant rule. A renewal charge arrives as BOTH
     * `payment.succeeded` and `subscription.renewed`; only the latter names the
     * period the money bought, so it alone grants.
     */
    it('grants nothing for a payment that funds a subscription', async () => {
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        makePrisma(),
        makeEvent(
          'payment.succeeded',
          packPaymentData({ subscription_id: 'sub_123', product_cart: null }),
        ),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
    });

    it('grants nothing for a one-time payment for an unconfigured product', async () => {
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        makePrisma(),
        makeEvent(
          'payment.succeeded',
          packPaymentData({ product_cart: [{ product_id: 'prod_someone_else', quantity: 1 }] }),
        ),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
    });

    /**
     * A `payment.succeeded` is also true of a fully-discounted payment, which
     * paid nothing. Currency is deliberately NOT in this refusal table: the
     * payment object carries the BUYER's settled currency, and Dodo (a Merchant
     * of Record) localizes at checkout, so refusing non-USD would strand every
     * localized buyer's pack in manual review — observed live in the 2026-08-31
     * test E2E, where a USD product's payment settled as INR.
     */
    it.each([
      ['a fully discounted payment', { total_amount: 0 }],
      ['a payment with no amount at all', { total_amount: null }],
    ])('does not grant a pack for %s', async (_label, overrides) => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('payment.succeeded', packPaymentData(overrides)),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

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

    /**
     * The real payment for the E2E test subscription settled as 1155716 INR for
     * a $99 USD product — Dodo converts and folds tax in at checkout. A pack
     * bought the same way is paid in full and must be granted.
     */
    it('grants a pack settled in the buyer\'s localized currency', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent(
          'payment.succeeded',
          packPaymentData({ total_amount: 1155716, currency: 'INR' }),
        ),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).toHaveBeenCalledTimes(1);
      // The observed settlement lands in the grant's audit row, since the gate
      // no longer pins the currency.
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              collectedAmount: 1155716,
              collectedCurrency: 'INR',
            }),
          }),
        }),
      );
    });

    /**
     * The cycle proof reads the SUBSCRIPTION object, whose currency is the
     * product's own — non-USD there is a misconfigured product, not a localized
     * buyer, so the equality stays.
     */
    it('refuses a cycle whose subscription is priced in a non-catalog currency', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('subscription.renewed', subscriptionData({ currency: 'INR' })),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'billing.grant_amount_review' }),
        }),
      );
    });

    it('does not grant included minutes for a cycle that collected nothing', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('subscription.renewed', subscriptionData({ recurring_pre_tax_amount: 0 })),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantSubscriptionCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'billing.grant_amount_review' }),
        }),
      );
    });

    it('records a payment whose status contradicts payment.succeeded for review', async () => {
      const prisma = makePrisma();
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('payment.succeeded', packPaymentData({ status: 'processing' })),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            action: 'billing.pack_payment_status_review',
          }),
        }),
      );
    });

    /**
     * Checkout metadata is set when the session is created, so it cannot be the
     * only proof of ownership: without this check one organization could fund
     * another organization's balance.
     */
    it('ignores a pack payment whose metadata organization does not own the customer', async () => {
      const prisma = makePrisma({ subscription: null });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, makeEvent('payment.succeeded', packPaymentData()), {
        creditLedger,
      });

      await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-1', dodoCustomerId: 'cus_123' },
        }),
      );
    });

    it('reverses pack credit through the payment recorded on the bucket', async () => {
      const prisma = makePrisma({
        fundedBucket: {
          organizationId: 'org-1',
          sourceType: 'purchased',
          sourceId: 'pay_pack_1',
        },
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('refund.succeeded', {
          refund_id: 're_1',
          payment_id: 'pay_pack_1',
          status: 'succeeded',
          is_partial: false,
          amount: 3900,
          customer: { customer_id: 'cus_123' },
        }),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(prisma.billingCreditBucket.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { dodoPaymentId: 'pay_pack_1' } }),
      );
      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        paymentId: 'pay_pack_1',
        refundId: 're_1',
        sourceType: 'purchased',
      });
    });

    /**
     * A dispute payload carries no customer, so the payment recorded on the bucket
     * is the only durable mapping back to the payer.
     */
    it('reverses a lost dispute through the payment recorded on the bucket', async () => {
      const prisma = makePrisma({
        fundedBucket: {
          organizationId: 'org-1',
          sourceType: 'purchased',
          sourceId: 'pay_pack_1',
        },
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('dispute.lost', {
          dispute_id: 'dp_1',
          payment_id: 'pay_pack_1',
          dispute_status: 'dispute_lost',
          dispute_stage: 'dispute',
          amount: '3900',
          currency: 'USD',
        }),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        paymentId: 'pay_pack_1',
        refundId: 'dp_1',
        sourceType: 'purchased',
      });
      expect(prisma.subscription.findMany).not.toHaveBeenCalled();
    });

    it('records a partial refund for review and acknowledges the event', async () => {
      const prisma = makePrisma({
        fundedBucket: {
          organizationId: 'org-1',
          sourceType: 'purchased',
          sourceId: 'pay_pack_1',
        },
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('refund.succeeded', {
          refund_id: 're_partial',
          payment_id: 'pay_pack_1',
          status: 'succeeded',
          is_partial: true,
          amount: 1_000,
          customer: { customer_id: 'cus_123' },
        }),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

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

    /**
     * A reversal we cannot attribute to a grant is recorded where a human sees it
     * and the event terminates. Throwing would 500-loop it for the provider's
     * whole retry window and then lose it — the reversal does not happen either
     * way, and only one of the two outcomes reaches a person.
     */
    it('records an unattributable refund for review instead of retrying forever', async () => {
      const prisma = makePrisma({ fundedBucket: null });
      const creditLedger = makeCreditLedger();
      const svc = makeService(
        prisma,
        makeEvent('refund.succeeded', {
          refund_id: 're_orphan',
          payment_id: 'pay_unknown',
          status: 'succeeded',
          is_partial: false,
          customer: { customer_id: 'cus_123' },
        }),
        { creditLedger },
      );

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.credit_reversal_unresolved',
            metadata: expect.objectContaining({ reason: 'no_recorded_grant' }),
          }),
        }),
      );
    });

    /**
     * A refunded SUBSCRIPTION CYCLE. Nothing on the refund payload names the cycle
     * and an included bucket carries no `dodo_payment_id`, so the payment is read
     * back from Dodo for its `subscription_id` and the bucket is found by the same
     * period join `bucketCoversPayment` uses in reconciliation.
     */
    function cycleRefund(overrides?: Record<string, unknown>): Record<string, unknown> {
      return makeEvent('refund.succeeded', {
        refund_id: 're_cycle',
        payment_id: 'pay_cycle_1',
        status: 'succeeded',
        is_partial: false,
        amount: 4900,
        customer: { customer_id: 'cus_123' },
        ...overrides,
      });
    }

    const CYCLE_SOURCE_ID = `sub:sub_123:${EVENT_AT}`;

    const retrievesCycle = (): ReturnType<typeof vi.fn> =>
      vi.fn(async () => ({
        payment_id: 'pay_cycle_1',
        subscription_id: 'sub_123',
        customer: { customer_id: 'cus_123' },
        created_at: EVENT_AT,
      }));

    it('reverses a refunded subscription cycle found by retrieving the payment', async () => {
      const prisma = makePrisma({
        fundedBucket: null,
        cycleBuckets: [{ sourceId: CYCLE_SOURCE_ID }],
      });
      const creditLedger = makeCreditLedger();
      const retrievePayment = retrievesCycle();
      const svc = makeService(prisma, cycleRefund(), { creditLedger, retrievePayment });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(retrievePayment).toHaveBeenCalledWith('pay_cycle_1');
      // Organization-scoped and keyed by the cycle prefix, with the period join:
      // the bucket whose period had not ended when the money was collected.
      expect(prisma.billingCreditBucket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-1',
            sourceType: 'included',
            sourceId: { startsWith: 'sub:sub_123:' },
            expiresAt: { gt: new Date(EVENT_AT) },
          },
          take: 10,
        }),
      );
      // The bucket's `sourceId`, not the payment id: that is what the ledger's
      // (organizationId, sourceType, sourceId) unique index is keyed by.
      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith({
        organizationId: 'org-1',
        paymentId: CYCLE_SOURCE_ID,
        refundId: 're_cycle',
        sourceType: 'included',
      });
    });

    /**
     * The regression the review asked for: after a renewal, the LATER cycle's
     * bucket shares the prefix and outlives the refunded payment, but its cycle
     * started after the payment — the lower bound must exclude it so an earlier
     * cycle's refund still resolves to exactly its own bucket instead of reading
     * as ambiguous forever (which would acknowledge the refund and leave the
     * refunded credit active).
     */
    it('still resolves an earlier cycle refund when a later renewal bucket exists', async () => {
      const prisma = makePrisma({
        fundedBucket: null,
        cycleBuckets: [
          { sourceId: CYCLE_SOURCE_ID },
          // A month after paidAt (EVENT_AT): unexpired, same prefix, later cycle.
          { sourceId: 'sub:sub_123:2027-02-15T00:00:00.000Z' },
        ],
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, cycleRefund(), {
        creditLedger,
        retrievePayment: retrievesCycle(),
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: CYCLE_SOURCE_ID, sourceType: 'included' }),
      );
    });

    /**
     * Genuine ambiguity is never guessed: a bucket whose cycle starts within the
     * grace window of the payment (the seconds-skew protection) and the payment's
     * own bucket both qualify, and that sliver goes to a human. An `activation`
     * key qualifies by construction and creates the same ambiguity.
     */
    it('records a cycle refund matching two qualifying buckets for review instead of guessing', async () => {
      const fiveMinAfterPaidAt = '2027-01-15T00:05:00.000Z';
      const prisma = makePrisma({
        fundedBucket: null,
        cycleBuckets: [
          { sourceId: CYCLE_SOURCE_ID },
          { sourceId: `sub:sub_123:${fiveMinAfterPaidAt}` },
        ],
      });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, cycleRefund(), {
        creditLedger,
        retrievePayment: retrievesCycle(),
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.credit_reversal_unresolved',
            metadata: expect.objectContaining({
              reason: 'ambiguous_cycle_bucket',
              dodoSubscriptionId: 'sub_123',
              coveringBuckets: 2,
            }),
          }),
        }),
      );
    });

    /**
     * The Dodo read-back is a best-effort enrichment, never a gate on the
     * delivery: the money already moved at Dodo, so a failed retrieve must leave
     * the event PROCESSED with a review row, not 500-looping until Dodo gives up.
     */
    it('records a cycle refund for review when the payment cannot be retrieved', async () => {
      const prisma = makePrisma({ fundedBucket: null });
      const creditLedger = makeCreditLedger();
      const svc = makeService(prisma, cycleRefund(), {
        creditLedger,
        retrievePayment: vi.fn(async () => {
          throw new Error('503 Service Unavailable');
        }),
      });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.billingCreditBucket.findMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.credit_reversal_unresolved',
            metadata: expect.objectContaining({
              reason: 'payment_retrieve_failed',
              retrieveError: expect.stringContaining('503'),
            }),
          }),
        }),
      );
      // Processed, so Dodo stops redelivering a reversal that will never resolve
      // itself: the review row is the record now.
      expect(prisma.dodoWebhookEvent.update).toHaveBeenCalled();
    });

    /**
     * Subscribed to but money-neutral: `dispute.won` and `payment.failed` are
     * recorded so support can read them back, and neither moves credit. A dispute
     * that was won is exactly why the reversal hangs off `dispute.lost` rather
     * than `dispute.*`.
     */
    it.each([
      [
        'dispute.won',
        { dispute_id: 'dp_won', payment_id: 'pay_pack_1', dispute_status: 'dispute_won' },
      ],
      ['payment.failed', { payment_id: 'pay_pack_1', status: 'failed', total_amount: 3900 }],
    ])('moves no credit on %s', async (type, data) => {
      const creditLedger = makeCreditLedger();
      const prisma = makePrisma({
        fundedBucket: {
          organizationId: 'org-1',
          sourceType: 'purchased',
          sourceId: 'pay_pack_1',
        },
      });
      const svc = makeService(prisma, makeEvent(type, data), { creditLedger });

      const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

      expect(result).toMatchObject({ handled: true, statusCode: 200 });
      expect(creditLedger.reversePurchasedCredits).not.toHaveBeenCalled();
      expect(creditLedger.grantPurchasedCredits).not.toHaveBeenCalled();
      expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
      // Still recorded: the row is what support reads back.
      expect(prisma.dodoWebhookEvent.create).toHaveBeenCalled();
      expect(prisma.dodoWebhookEvent.update).toHaveBeenCalled();
    });
  });

  it('persists a null period instead of failing when Dodo omits it entirely', async () => {
    const prisma = makePrisma();
    const svc = makeService(
      prisma,
      makeEvent(
        'subscription.plan_changed',
        subscriptionData({ previous_billing_date: null, next_billing_date: null }),
      ),
    );

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    // Must not 500: a 500 makes Dodo retry and eventually disable the endpoint.
    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    const [args] = prisma.subscription.updateMany.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    expect(args[0].data).not.toHaveProperty('currentPeriodEnd');
  });

  it('persists and acknowledges unknown events without changing billing state', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma, makeEvent('license_key.created', { license_key: 'lk_1' }));

    const result = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(prisma.dodoWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          webhookId: 'wh_1',
          type: 'license_key.created',
        }),
      }),
    );
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Deliver-twice idempotency, one case per handled event type.
 *
 * Dodo redelivers: on a timeout, on a 5xx, and by hand from the dashboard — and
 * `reclaimStuckEvents` re-dispatches a stored payload of its own accord. So "the
 * same event twice" is normal traffic, not an edge case, and every handler has to
 * make its effect happen exactly once. The `replayable` prisma mock makes the
 * event row behave like the real unique index across the two deliveries, so these
 * tests exercise the actual claim rather than a stateless stub that lets both
 * deliveries through.
 *
 * The second delivery must also be ACKNOWLEDGED (200). A 5xx there keeps Dodo
 * retrying work that is already done, and eventually disables the endpoint.
 */
interface ReplayCase {
  /** The Dodo event type, cross-checked against `dispatch`'s switch below. */
  type: string;
  name: string;
  event: () => unknown;
  prisma?: Parameters<typeof makePrisma>[0];
  /** The single write or grant that must happen exactly once. */
  effect: (
    prisma: ReturnType<typeof makePrisma>,
    ledger: ReturnType<typeof makeCreditLedger>,
  ) => ReturnType<typeof vi.fn>;
}

const FUNDED_BUCKET = {
  fundedBucket: { organizationId: 'org-1', sourceType: 'purchased', sourceId: 'pay_pack_1' },
};

const REPLAY_CASES: ReplayCase[] = [
  {
    type: 'payment.succeeded',
    name: 'payment.succeeded grants a minute pack once',
    event: () => makeEvent('payment.succeeded', packPaymentData()),
    effect: (_prisma, ledger) => ledger.grantPurchasedCredits,
  },
  {
    type: 'subscription.active',
    name: 'subscription.active links the subscription once',
    event: () => makeEvent('subscription.active', subscriptionData()),
    effect: (prisma) => prisma.subscription.upsert,
  },
  {
    type: 'subscription.renewed',
    name: 'subscription.renewed grants included credit once',
    event: () => makeEvent('subscription.renewed', subscriptionData()),
    effect: (_prisma, ledger) => ledger.grantSubscriptionCredits,
  },
  {
    type: 'subscription.plan_changed',
    name: 'subscription.plan_changed syncs once',
    event: () => makeEvent('subscription.plan_changed', subscriptionData()),
    effect: (prisma) => prisma.subscription.updateMany,
  },
  {
    type: 'subscription.on_hold',
    name: 'subscription.on_hold marks past_due once',
    event: () => makeEvent('subscription.on_hold', subscriptionData({ status: 'on_hold' })),
    effect: (prisma) => prisma.subscription.updateMany,
  },
  {
    type: 'subscription.failed',
    name: 'subscription.failed marks unpaid once',
    event: () => makeEvent('subscription.failed', subscriptionData({ status: 'failed' })),
    effect: (prisma) => prisma.subscription.updateMany,
  },
  {
    type: 'subscription.cancelled',
    name: 'subscription.cancelled cancels once',
    event: () => makeEvent('subscription.cancelled', subscriptionData({ status: 'cancelled' })),
    effect: (prisma) => prisma.subscription.updateMany,
  },
  {
    type: 'subscription.expired',
    name: 'subscription.expired cancels once',
    event: () => makeEvent('subscription.expired', subscriptionData({ status: 'expired' })),
    effect: (prisma) => prisma.subscription.updateMany,
  },
  {
    type: 'refund.succeeded',
    name: 'refund.succeeded reverses credit once',
    prisma: FUNDED_BUCKET,
    event: () =>
      makeEvent('refund.succeeded', {
        refund_id: 're_replay',
        payment_id: 'pay_pack_1',
        status: 'succeeded',
        is_partial: false,
        customer: { customer_id: 'cus_123' },
      }),
    effect: (_prisma, ledger) => ledger.reversePurchasedCredits,
  },
  {
    type: 'dispute.lost',
    name: 'dispute.lost reverses pack credit once',
    prisma: FUNDED_BUCKET,
    event: () =>
      makeEvent('dispute.lost', {
        dispute_id: 'dp_replay',
        payment_id: 'pay_pack_1',
        dispute_status: 'dispute_lost',
      }),
    effect: (_prisma, ledger) => ledger.reversePurchasedCredits,
  },
  // The money-neutral pair: the only effect either may have is the event row, and
  // a redelivery must not add a second one.
  {
    type: 'payment.failed',
    name: 'payment.failed is recorded once and grants nothing',
    event: () => makeEvent('payment.failed', { payment_id: 'pay_failed', status: 'failed' }),
    effect: (prisma) => prisma.dodoWebhookEvent.update,
  },
  {
    type: 'dispute.won',
    name: 'dispute.won is recorded once and reverses nothing',
    prisma: FUNDED_BUCKET,
    event: () =>
      makeEvent('dispute.won', {
        dispute_id: 'dp_won_replay',
        payment_id: 'pay_pack_1',
        dispute_status: 'dispute_won',
      }),
    effect: (prisma) => prisma.dodoWebhookEvent.update,
  },
];

describe('DodoWebhookService duplicate delivery', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    setEnv();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(REPLAY_CASES)('$name across two deliveries', async (replay) => {
    const prisma = makePrisma({ ...replay.prisma, replayable: true });
    const creditLedger = makeCreditLedger();
    const svc = makeService(prisma, replay.event(), { creditLedger });

    const first = await svc.handleWebhook(Buffer.from('{}'), HEADERS);
    const second = await svc.handleWebhook(Buffer.from('{}'), HEADERS);

    expect(first).toMatchObject({ handled: true, statusCode: 200 });
    // Acknowledged, not retried: the work is done and Dodo must stop.
    expect(second).toMatchObject({ handled: true, statusCode: 200 });
    expect(replay.effect(prisma, creditLedger)).toHaveBeenCalledTimes(1);
    // Proof the second delivery went through the claim rather than the mock
    // simply forgetting the first one.
    expect(prisma.dodoWebhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.dodoWebhookEvent.update).toHaveBeenCalledTimes(1);
  });
});

/**
 * Docs-vs-code drift guard.
 *
 * An operator configures the Dodo endpoint from the runbook, not from this file,
 * so a wrong event name in the runbook is a production defect with no failing
 * test anywhere: the endpoint is configured as documented, the handler never
 * fires, and nothing complains. This happened under Stripe — the runbook said
 * `charge.dispute.created`, the code reversed on `charge.dispute.closed`, and the
 * gap silently left disputed minute-pack credit on the account.
 */
describe('documented Dodo webhook subscription list', () => {
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
    const src = read('apps/api/src/webhooks/dodo-webhook.service.ts');
    const start = src.indexOf('switch (event.type) {');
    const end = src.indexOf('default:', start);
    if (start < 0 || end < 0) throw new Error('could not locate the dispatch switch');
    return [...src.slice(start, end).matchAll(/case '([^']+)'/g)].map((m) => m[1] as string).sort();
  })();

  it('is a non-trivial set, so an empty parse cannot pass vacuously', () => {
    expect(handled.length).toBeGreaterThan(5);
  });

  /**
   * Every handled type also needs a deliver-twice test, and a hand-kept list
   * would rot the moment another `case` is added. Parsed from the switch, so a new
   * handler with no replay test fails here instead of in production.
   */
  it('has a duplicate-delivery test for every handled event type', () => {
    expect([...new Set(REPLAY_CASES.map((c) => c.type))].sort()).toEqual([...new Set(handled)]);
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
    // Located by shape rather than by the provider's name, so renaming the
    // heading is the docs' business and this guard still only cares that the
    // list equals the handled set.
    const heading = /^## .*Webhooks$/m.exec(doc);
    if (!heading) throw new Error('could not locate the webhook section in docs/16_BILLING.md');
    const line = doc
      .slice(heading.index)
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
