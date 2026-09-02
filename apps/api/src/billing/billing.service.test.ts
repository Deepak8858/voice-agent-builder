import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { APIError } from 'dodopayments';
import { BILLING_CATALOG_VERSION } from '@voiceforge/shared';
import { BillingService, BillingUnavailableError, ForbiddenPlanError } from './billing.service';
import { CreditLedgerService } from './credit-ledger.service';
import { EntitlementService } from './entitlement.service';
import { env } from '../config/env';

/** The signed-in owner/admin whose id every money route must audit. */
const ACTOR = 'user-1';

function makePrisma(overrides?: {
  subscription?: unknown;
  agentCount?: number;
  workspaceCount?: number;
  integrationToolCount?: number;
  creditBalance?: unknown;
  creditBuckets?: unknown[];
  usageRecords?: unknown[];
  callUsages?: unknown[];
  workspace?: { organizationId: string };
  auditLog?: { create?: ReturnType<typeof vi.fn> };
}) {
  const state = {
    subscription: overrides?.subscription ?? null,
    agentCount: overrides?.agentCount ?? 0,
    workspaceCount: overrides?.workspaceCount ?? 0,
    integrationToolCount: overrides?.integrationToolCount ?? 0,
    creditBalance: overrides?.creditBalance ?? null,
    creditBuckets: overrides?.creditBuckets ?? [],
    usageRecords: overrides?.usageRecords ?? [],
    callUsages: overrides?.callUsages ?? [],
    workspace: overrides?.workspace ?? { organizationId: 'org-1' },
  };
  return {
    subscription: {
      findUnique: vi.fn(async () => state.subscription),
      upsert: vi.fn(async () => ({ id: 'sub-1', ...state.subscription })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    organization: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: state.workspace.organizationId,
        name: 'Test Org',
        // Dodo requires an email to create a customer; the organization owner is
        // the only billing contact this product stores.
        owner: { email: 'owner@voiceforge.test' },
      })),
    },
    workspace: {
      findUniqueOrThrow: vi.fn(async () => state.workspace),
      findUnique: vi.fn(async () => state.workspace),
      count: vi.fn(async () => state.workspaceCount),
    },
    agent: {
      count: vi.fn(async () => state.agentCount),
    },
    integrationTool: {
      count: vi.fn(async () => state.integrationToolCount),
    },
    organizationCreditBalance: {
      findUnique: vi.fn(async () => state.creditBalance),
    },
    billingCreditBucket: {
      findMany: vi.fn(async () => state.creditBuckets),
    },
    usageRecord: {
      findMany: vi.fn(async () => state.usageRecords),
      create: vi.fn(async () => ({ id: 'ur-1' })),
    },
    callUsage: {
      findMany: vi.fn(async () => state.callUsages),
    },
    auditLog: overrides?.auditLog ?? {
      create: vi.fn(async () => ({ id: 'audit-1' })),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>, cache?: unknown) {
  // The real collaborators are constructed against the same Prisma mock rather
  // than stubbed, so these tests exercise the single production decision path
  // (BillingModule provides the same wiring) instead of a test-only branch.
  return new BillingService(
    prisma as never,
    new EntitlementService(prisma as never),
    new CreditLedgerService(prisma as never),
    cache as never,
  );
}

const CHECKOUT_URL = 'https://checkout.dodopayments.com/session';
const PORTAL_URL = 'https://test.dodopayments.com/portal/session';

describe('BillingService', () => {
  let mockDodo: {
    customers: {
      create: ReturnType<typeof vi.fn>;
      customerPortal: { create: ReturnType<typeof vi.fn> };
    };
    checkoutSessions: { create: ReturnType<typeof vi.fn> };
    payments: { list: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(env, {
      DODO_PAYMENTS_API_KEY: 'dodo_test_123',
      DODO_WEBHOOK_SECRET: 'whsec_test_123',
      DODO_PAYMENTS_ENVIRONMENT: 'test_mode',
      DODO_STARTER_PRODUCT_ID: 'prod_starter',
      DODO_GROWTH_PRODUCT_ID: 'prod_growth',
      DODO_ENTERPRISE_PRODUCT_ID: 'prod_enterprise',
      DODO_MINUTE_PACK_PRODUCT_ID: 'prod_minute_pack',
      WEB_BASE_URL: 'https://app.voiceforge.test',
    });
    mockDodo = {
      customers: {
        create: vi.fn(async () => ({ customer_id: 'cus_new' })),
        customerPortal: { create: vi.fn(async () => ({ link: PORTAL_URL })) },
      },
      checkoutSessions: {
        create: vi.fn(async () => ({ session_id: 'cks_1', checkout_url: CHECKOUT_URL })),
      },
      payments: { list: vi.fn(async () => ({ items: [] })) },
    };
  });

  describe('getBillingStatus', () => {
    it('reports checkout configured when every server-owned identifier is present', () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      expect(svc.getBillingStatus()).toEqual({
        liveCheckoutEnabled: true,
        topUpEnabled: true,
        portalEnabled: true,
        message: 'Live checkout and customer portal actions are enabled.',
      });
    });

    /**
     * The pack product disables packs and nothing else. Subscription checkout and
     * the portal are configured independently, and reporting them as unavailable
     * turned one unset variable into a total revenue outage: the client disabled
     * every billing button on this one flag.
     */
    it('reports only top-up unavailable when the minute-pack product is missing', () => {
      Object.assign(env, { DODO_MINUTE_PACK_PRODUCT_ID: undefined });
      const prisma = makePrisma();
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      expect(svc.getBillingStatus()).toEqual({
        liveCheckoutEnabled: true,
        topUpEnabled: false,
        portalEnabled: true,
        message:
          'Checkout is temporarily unavailable. No plan change was made and no free allowance was granted.',
      });
    });

    /**
     * The webhook secret is the one variable every entry point needs: without a
     * verifiable feed, a portal cancellation or a completed Checkout never
     * reaches us, so the customer is charged and nothing changes on our side.
     */
    it('reports every entry point unavailable when the webhook secret is missing', () => {
      Object.assign(env, { DODO_WEBHOOK_SECRET: undefined });
      const prisma = makePrisma();
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      expect(svc.getBillingStatus()).toMatchObject({
        liveCheckoutEnabled: false,
        topUpEnabled: false,
        portalEnabled: false,
      });
    });

    /**
     * Packs are sold from a paid plan, so a deployment that can sell packs but
     * has no plan products is misconfigured in the direction that matters most.
     */
    it('reports subscription checkout unavailable when a plan product is missing', () => {
      Object.assign(env, { DODO_GROWTH_PRODUCT_ID: undefined });
      const prisma = makePrisma();
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      expect(svc.getBillingStatus()).toMatchObject({
        liveCheckoutEnabled: false,
        topUpEnabled: true,
        portalEnabled: true,
      });
    });
  });

  describe('createCheckoutSession', () => {
    it('refuses checkout without calling Dodo when the webhook secret is missing', async () => {
      Object.assign(env, { DODO_WEBHOOK_SECRET: undefined });
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'starter',
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: '/dashboard/billing?checkout=success',
        cancelPath: '/dashboard/billing?checkout=cancel',
      }, ACTOR)).rejects.toMatchObject({
        errorCode: 'BILLING_UNAVAILABLE',
      });

      expect(mockDodo.checkoutSessions.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    /**
     * The split's whole point, as behaviour rather than a status flag: an unset
     * minute-pack product must not stop anyone from upgrading. Before the entry
     * points had separate configuration lists, this call returned 503.
     */
    it('still takes a subscription payment when the minute-pack product is missing', async () => {
      Object.assign(env, { DODO_MINUTE_PACK_PRODUCT_ID: undefined });
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'starter',
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: '/dashboard/billing?checkout=success',
        cancelPath: '/dashboard/billing?checkout=cancel',
      }, ACTOR)).resolves.toEqual({ url: CHECKOUT_URL });
    });

    it('maps plan to the server-owned product and both redirect URLs', async () => {
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await svc.createCheckoutSession('org-1', {
        plan: 'starter',
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: '/dashboard/billing?checkout=success',
        cancelPath: '/dashboard/billing?checkout=cancel',
      }, ACTOR);

      expect(mockDodo.checkoutSessions.create).toHaveBeenCalledWith({
        product_cart: [{ product_id: 'prod_starter', quantity: 1 }],
        customer: { customer_id: 'cus_123' },
        return_url: 'https://app.voiceforge.test/dashboard/billing?checkout=success',
        cancel_url: 'https://app.voiceforge.test/dashboard/billing?checkout=cancel',
        metadata: expect.objectContaining({
          organizationId: 'org-1',
          plan: 'starter',
          catalogVersion: BILLING_CATALOG_VERSION,
        }),
      });
      // As a Merchant of Record Dodo owns tax, so there is no tax switch to leave
      // off, and a subscription session must not be pinned to a payment method.
      const session = mockDodo.checkoutSessions.create.mock.calls[0][0] as Record<string, unknown>;
      expect(session).not.toHaveProperty('allowed_payment_method_types');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.checkout_started',
            resourceType: 'subscription',
            // The row was written with a null actor, so the audit log could not
            // say who started a payment. It comes from the session, never the body.
            actorUserId: ACTOR,
          }),
        }),
      );
    });

    /**
     * The identifier correlates one attempt between our audit log and the Dodo
     * dashboard, so it must be unique per request rather than per deployment.
     */
    it('stamps a distinct integration identifier on every Checkout attempt', async () => {
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });
      const dto = {
        plan: 'starter' as const,
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: '/dashboard/billing?checkout=success',
        cancelPath: '/dashboard/billing?checkout=cancel',
      };

      await svc.createCheckoutSession('org-1', dto, ACTOR);
      await svc.createCheckoutSession('org-1', dto, ACTOR);

      const [first, second] = mockDodo.checkoutSessions.create.mock.calls.map(
        (call) => (call[0] as { metadata: Record<string, string> }).metadata.integration_identifier,
      );
      expect(first).toMatch(/^vf_[0-9a-f]{24}$/);
      expect(second).toMatch(/^vf_[0-9a-f]{24}$/);
      expect(first).not.toBe(second);
    });

    it('rejects unsafe checkout paths before calling Dodo', async () => {
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'starter',
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: 'https://evil.example/success',
        cancelPath: '/dashboard/billing',
      }, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockDodo.checkoutSessions.create).not.toHaveBeenCalled();
    });

    /**
     * Enterprise is sales-assisted and has no self-service product. A forged plan
     * value must be refused before Dodo is contacted.
     */
    it('rejects a plan outside the self-service checkout catalog', async () => {
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'enterprise' as never,
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: '/dashboard/billing',
        cancelPath: '/dashboard/billing',
      }, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockDodo.checkoutSessions.create).not.toHaveBeenCalled();
    });

    /**
     * Dodo will happily create a second subscription for the same customer. The
     * customer is then billed twice, and the Subscription row can hold only one
     * subscription id — the other keeps billing with nothing here able to
     * resolve, refund, or cancel it. Plan changes belong in the customer portal,
     * which mutates the subscription in place.
     */
    it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused'])(
      'refuses a second subscription checkout while one is %s',
      async (status) => {
        const prisma = makePrisma({
          subscription: { dodoCustomerId: 'cus_123', dodoSubscriptionId: 'sub_live', status },
        });
        const svc = makeService(prisma);
        Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

        await expect(svc.createCheckoutSession('org-1', {
          plan: 'growth',
          idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
          successPath: '/dashboard/billing',
          cancelPath: '/dashboard/billing',
        }, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
        expect(mockDodo.checkoutSessions.create).not.toHaveBeenCalled();
      },
    );

    /**
     * An abandoned or cancelled attempt leaves the subscription id on the row
     * with nothing live behind it, so a fresh Checkout is the normal recovery
     * path and must stay open.
     */
    it.each(['incomplete', 'incomplete_expired', 'canceled'])(
      'still allows checkout when the recorded subscription is %s',
      async (status) => {
        const prisma = makePrisma({
          subscription: { dodoCustomerId: 'cus_123', dodoSubscriptionId: 'sub_dead', status },
        });
        const svc = makeService(prisma);
        Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

        await expect(svc.createCheckoutSession('org-1', {
          plan: 'growth',
          idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
          successPath: '/dashboard/billing',
          cancelPath: '/dashboard/billing',
        }, ACTOR)).resolves.toEqual({ url: CHECKOUT_URL });
      },
    );

    /**
     * Observed live at cutover: `checkoutSessions.create` answered
     * `403 {"code":"MERCHANT_NOT_LIVE"}` and the customer got an unhandled 500. A
     * Dodo 4xx is a statement about the merchant account or the catalog, not a
     * crash here, so it is the same 503 an unconfigured deployment returns — with
     * the provider's code named so support can act on it.
     */
    it('maps a Dodo 4xx to billing-unavailable rather than a 500', async () => {
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      mockDodo.checkoutSessions.create.mockRejectedValue(
        new APIError(403, { code: 'MERCHANT_NOT_LIVE' }, 'Merchant is not live', undefined),
      );
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      const rejection = await svc
        .createCheckoutSession('org-1', {
          plan: 'starter',
          idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
          successPath: '/dashboard/billing',
          cancelPath: '/dashboard/billing',
        }, ACTOR)
        .catch((err: unknown) => err);

      expect(rejection).toBeInstanceOf(BillingUnavailableError);
      expect((rejection as BillingUnavailableError).getStatus()).toBe(503);
      expect((rejection as Error).message).toContain('MERCHANT_NOT_LIVE');
      // Nothing was started at Dodo, so nothing may be audited as started.
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    /**
     * The other arm: a 5xx is transient, the SDK has already retried it, and
     * telling the customer "temporarily unavailable" would hide a real outage
     * behind a soft error.
     */
    it('leaves a Dodo 5xx as a server error', async () => {
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      const upstream = new APIError(503, { code: 'UPSTREAM' }, 'Dodo is down', undefined);
      mockDodo.checkoutSessions.create.mockRejectedValue(upstream);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(svc.createCheckoutSession('org-1', {
        plan: 'starter',
        idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
        successPath: '/dashboard/billing',
        cancelPath: '/dashboard/billing',
      }, ACTOR)).rejects.toBe(upstream);
    });
  });

  describe('createTopUpCheckoutSession', () => {
    const topUpDto = {
      idempotencyKey: '1f3b51d8-8fcb-4bc8-b795-45fb53be8e8d',
      successPath: '/dashboard/billing?topup=success',
      cancelPath: '/dashboard/billing?topup=cancel',
    };

    it('starts a one-time Checkout against the server-owned minute-pack product', async () => {
      const prisma = makePrisma({
        subscription: {
          dodoCustomerId: 'cus_123',
          plan: 'growth',
          status: 'active',
          trialEnd: null,
          concurrentCallLimitOverride: null,
        },
      });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await svc.createTopUpCheckoutSession('org-1', topUpDto, ACTOR);

      expect(mockDodo.checkoutSessions.create).toHaveBeenCalledWith({
        product_cart: [{ product_id: 'prod_minute_pack', quantity: 1 }],
        customer: { customer_id: 'cus_123' },
        // Cards only: the pack is granted from `payment.succeeded` and nothing
        // grants it later, so a method that settles days after checkout would be
        // paid for and never credited.
        allowed_payment_method_types: ['credit', 'debit'],
        return_url: 'https://app.voiceforge.test/dashboard/billing?topup=success',
        cancel_url: 'https://app.voiceforge.test/dashboard/billing?topup=cancel',
        metadata: expect.objectContaining({
          organizationId: 'org-1',
          purchaseType: 'minute_pack',
          catalogVersion: BILLING_CATALOG_VERSION,
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'billing.topup_checkout_started' }),
        }),
      );
    });

    /**
     * A deployment missing the server-owned pack product cannot grant what a
     * customer would pay for, so it must refuse before Dodo is contacted rather
     * than take the payment and fail afterwards.
     */
    it('refuses a pack when the minute-pack product is not configured', async () => {
      Object.assign(env, { DODO_MINUTE_PACK_PRODUCT_ID: undefined });
      const prisma = makePrisma({
        subscription: {
          dodoCustomerId: 'cus_123',
          plan: 'growth',
          status: 'active',
          trialEnd: null,
          concurrentCallLimitOverride: null,
        },
      });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(svc.createTopUpCheckoutSession('org-1', topUpDto, ACTOR)).rejects.toBeInstanceOf(
        BillingUnavailableError,
      );
      expect(mockDodo.checkoutSessions.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    /**
     * Packs are consumed after included minutes, so an organization without a
     * funded subscription must not be able to buy one.
     */
    it('refuses a pack for an organization without paid access', async () => {
      const prisma = makePrisma({
        subscription: {
          dodoCustomerId: 'cus_123',
          plan: 'growth',
          status: 'past_due',
          trialEnd: null,
          concurrentCallLimitOverride: null,
        },
      });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(svc.createTopUpCheckoutSession('org-1', topUpDto, ACTOR)).rejects.toBeInstanceOf(
        ForbiddenPlanError,
      );
      expect(mockDodo.checkoutSessions.create).not.toHaveBeenCalled();
    });
  });

  describe('getBillingSummary', () => {
    const growthSubscription = {
      id: '5f7d4d3a-9a1f-4a2f-8f1a-2b3c4d5e6f70',
      plan: 'growth',
      status: 'active',
      // Relative on purpose. The summary asserts a funded `growth` plan, and
      // paid access now requires a period that has not already ended, so a
      // hard-coded date would turn this suite red on a calendar day rather than
      // on a code change.
      currentPeriodStart: new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000),
      currentPeriodEnd: new Date(Date.now() + 25 * 24 * 60 * 60 * 1_000),
      cancelAtPeriodEnd: false,
      trialEnd: null,
      concurrentCallLimitOverride: null,
      dodoCustomerId: 'cus_123',
    };

    function makeSummaryPrisma() {
      const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1_000);
      const later = new Date(Date.now() + 200 * 24 * 60 * 60 * 1_000);
      return makePrisma({
        subscription: growthSubscription,
        agentCount: 4,
        workspaceCount: 2,
        integrationToolCount: 3,
        creditBalance: {
          availableSeconds: 9_000,
          reservedSeconds: 120,
          status: 'active',
          reviewReason: null,
        },
        creditBuckets: [
          { sourceType: 'included', remainingSeconds: 3_000, expiresAt: soon },
          { sourceType: 'purchased', remainingSeconds: 6_000, expiresAt: later },
        ],
      });
    }

    it('separates included, purchased, reserved, and expiring seconds', async () => {
      const svc = makeService(makeSummaryPrisma());

      const summary = await svc.getBillingSummary('org-1');

      expect(summary).toMatchObject({
        organizationId: 'org-1',
        plan: 'growth',
        status: 'active',
        paidAccess: true,
        catalogVersion: BILLING_CATALOG_VERSION,
        currentPeriodEnd: growthSubscription.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: false,
        includedSeconds: 3_000,
        purchasedSeconds: 6_000,
        reservedSeconds: 120,
        expiringSeconds: 0,
        availableSeconds: 9_000,
        balanceStatus: 'active',
        blockedReason: 'allowed',
      });
      expect(summary.entitlements).toMatchObject({
        includedMinutes: 1_000,
        agents: 10,
        workspaces: 5,
        concurrentCalls: 10,
        whiteLabel: true,
      });
    });

    /**
     * Quotas and credit belong to the organization, so the same totals must be
     * returned no matter which of its workspaces the dashboard was opened from.
     */
    it('returns organization totals rather than workspace-scoped counts', async () => {
      const prisma = makeSummaryPrisma();
      const svc = makeService(prisma);

      const summary = await svc.getBillingSummary('org-1');

      expect(summary.usage).toEqual({ agents: 4, workspaces: 2, integrations: 3 });
      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { workspace: { organizationId: 'org-1' } },
      });
      expect(prisma.workspace.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
      });
      expect(prisma.integrationTool.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
      });
    });

    /**
     * The summary is what a customer reads to understand why calls are not
     * running, so it must report the same denial the runtime would produce.
     */
    it('reports the reason a paid call would currently be refused', async () => {
      const prisma = makePrisma({
        subscription: { ...growthSubscription, status: 'past_due' },
      });
      const svc = makeService(prisma);

      const summary = await svc.getBillingSummary('org-1');

      expect(summary).toMatchObject({
        plan: 'free',
        status: 'past_due',
        paidAccess: false,
        blockedReason: 'subscription_inactive',
      });
    });

    it('reports zeroes for an organization that has never been granted credit', async () => {
      const svc = makeService(makePrisma({ subscription: null }));

      const summary = await svc.getBillingSummary('org-new');

      expect(summary).toMatchObject({
        plan: 'free',
        status: 'none',
        includedSeconds: 0,
        purchasedSeconds: 0,
        reservedSeconds: 0,
        expiringSeconds: 0,
        availableSeconds: 0,
        currentPeriodEnd: null,
      });
    });
  });

  describe('createPortalSession', () => {
    it('refuses the customer portal without calling Dodo when checkout is unconfigured', async () => {
      Object.assign(env, { DODO_WEBHOOK_SECRET: undefined });
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(
        svc.createPortalSession('org-1', { returnPath: '/dashboard/billing' }, ACTOR),
      ).rejects.toMatchObject({
        errorCode: 'BILLING_UNAVAILABLE',
      });

      expect(mockDodo.customers.customerPortal.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    /**
     * The portal sells nothing, so it needs no product. Blocking it on the
     * product IDs meant an existing subscriber could not update a failing card or
     * download an invoice — which converts a checkout misconfiguration into
     * involuntary churn.
     */
    it('opens the portal with no product IDs configured at all', async () => {
      Object.assign(env, {
        DODO_STARTER_PRODUCT_ID: undefined,
        DODO_GROWTH_PRODUCT_ID: undefined,
        DODO_MINUTE_PACK_PRODUCT_ID: undefined,
      });
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(
        svc.createPortalSession('org-1', { returnPath: '/dashboard/billing' }, ACTOR),
      ).resolves.toEqual({ url: PORTAL_URL });
    });

    it('builds the customer portal return URL from WEB_BASE_URL', async () => {
      const prisma = makePrisma({ subscription: { dodoCustomerId: 'cus_123' } });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await svc.createPortalSession('org-1', { returnPath: '/dashboard/billing' }, ACTOR);

      // The customer id is a path parameter on Dodo's portal endpoint, not a body
      // field, and there is no configuration object to pass: the portal's feature
      // set belongs to the Dodo merchant account, so STRIPE_PORTAL_CONFIGURATION_ID
      // has no successor.
      expect(mockDodo.customers.customerPortal.create).toHaveBeenCalledWith('cus_123', {
        return_url: 'https://app.voiceforge.test/dashboard/billing',
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'billing.portal_opened',
            resourceType: 'subscription',
          }),
        }),
      );
    });

    /**
     * The portal needs a customer that exists at Dodo. An organization that has
     * never checked out has none, so one is created and stored — otherwise the
     * portal 404s for exactly the customers most likely to need it.
     */
    it('creates and stores a Dodo customer for an organization that has none', async () => {
      const prisma = makePrisma({ subscription: null });
      const svc = makeService(prisma);
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });

      await expect(
        svc.createPortalSession('org-1', { returnPath: '/dashboard/billing' }, ACTOR),
      ).resolves.toEqual({ url: PORTAL_URL });

      expect(mockDodo.customers.create).toHaveBeenCalledWith({
        email: 'owner@voiceforge.test',
        name: 'Test Org',
        metadata: { organizationId: 'org-1' },
      });
      expect(prisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-1' },
          update: { dodoCustomerId: 'cus_new' },
        }),
      );
      expect(mockDodo.customers.customerPortal.create).toHaveBeenCalledWith(
        'cus_new',
        expect.anything(),
      );
    });
  });

  /**
   * Dodo has no listable invoice object, so history is built from payments. The
   * DTO the dashboard reads is unchanged.
   */
  describe('getInvoices', () => {
    it('maps Dodo payments onto the invoice DTO', async () => {
      // Derived, not hardcoded: an epoch literal here would only assert that two
      // constants match each other.
      const first = Date.parse('2027-01-15T00:00:00.000Z') / 1000;
      const second = Date.parse('2027-01-16T00:00:00.000Z') / 1000;
      const svc = makeService(makePrisma());
      Object.assign(svc as unknown as { dodo: typeof mockDodo }, { dodo: mockDodo });
      mockDodo.payments.list = vi.fn(async () => ({
        items: [
          {
            payment_id: 'pay_1',
            invoice_id: 'inv_1',
            invoice_url: 'https://test.dodopayments.com/invoices/inv_1.pdf',
            status: 'succeeded',
            total_amount: 4900,
            currency: 'USD',
            created_at: '2027-01-15T00:00:00.000Z',
          },
          // Not collected, so nothing may be reported as paid.
          {
            payment_id: 'pay_2',
            status: 'failed',
            total_amount: 4900,
            currency: 'USD',
            created_at: '2027-01-16T00:00:00.000Z',
          },
        ],
      }));

      await expect(svc.getInvoices('cus_123')).resolves.toEqual({
        items: [
          {
            id: 'pay_1',
            number: 'inv_1',
            status: 'succeeded',
            amountDue: 4900,
            amountPaid: 4900,
            currency: 'USD',
            created: first,
            periodStart: first,
            periodEnd: first,
            invoicePdf: 'https://test.dodopayments.com/invoices/inv_1.pdf',
            hostedInvoiceUrl: 'https://test.dodopayments.com/invoices/inv_1.pdf',
          },
          {
            id: 'pay_2',
            number: null,
            status: 'failed',
            amountDue: 4900,
            amountPaid: 0,
            currency: 'USD',
            created: second,
            periodStart: second,
            periodEnd: second,
            invoicePdf: null,
            hostedInvoiceUrl: null,
          },
        ],
      });
      expect(mockDodo.payments.list).toHaveBeenCalledWith({
        customer_id: 'cus_123',
        page_size: 12,
      });
    });

    it('returns an empty list when Dodo is not configured', async () => {
      const svc = makeService(makePrisma());
      Object.assign(svc as unknown as { dodo: unknown }, { dodo: null });

      await expect(svc.getInvoices('cus_123')).resolves.toEqual({ items: [] });
    });
  });

  describe('getSubscription', () => {
    it('returns null for free org with no subscription row', async () => {
      const prisma = makePrisma({ subscription: null });
      const svc = makeService(prisma);
      const result = await svc.getSubscription('org-no-sub');
      expect(result).toBeNull();
    });

    it('returns subscription DTO when row exists', async () => {
      const sub = {
        id: 'sub-1',
        plan: 'starter',
        status: 'active',
        currentPeriodStart: new Date('2026-01-01'),
        currentPeriodEnd: new Date('2026-01-31'),
        cancelAtPeriodEnd: false,
        trialEnd: null,
        dodoCustomerId: 'cus_123',
      };
      const prisma = makePrisma({ subscription: sub });
      const svc = makeService(prisma);
      const result = await svc.getSubscription('org-1');
      expect(result).toMatchObject({
        id: 'sub-1',
        plan: 'starter',
        status: 'active',
        dodoCustomerId: 'cus_123',
      });
    });

    it('caches subscription DTOs in Redis for repeated dashboard billing checks', async () => {
      const sub = {
        id: 'sub-1',
        plan: 'growth',
        status: 'active',
        currentPeriodStart: new Date('2026-01-01'),
        currentPeriodEnd: new Date('2026-01-31'),
        cancelAtPeriodEnd: false,
        trialEnd: null,
        dodoCustomerId: 'cus_123',
      };
      const prisma = makePrisma({ subscription: sub });
      const cache = {
        get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: 'sub-1',
          plan: 'growth',
          status: 'active',
          currentPeriodStart: '2026-01-01T00:00:00.000Z',
          currentPeriodEnd: '2026-01-31T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          trialEnd: null,
          dodoCustomerId: 'cus_123',
        }),
        set: vi.fn(async () => undefined),
      };
      const svc = makeService(prisma, cache);

      await expect(svc.getSubscription('org-1')).resolves.toMatchObject({
        id: 'sub-1',
        plan: 'growth',
      });
      await expect(svc.getSubscription('org-1')).resolves.toMatchObject({
        id: 'sub-1',
        plan: 'growth',
      });

      expect(cache.get).toHaveBeenCalledWith('billing:subscription:org-1');
      expect(cache.set).toHaveBeenCalledWith(
        'billing:subscription:org-1',
        expect.objectContaining({ id: 'sub-1', plan: 'growth' }),
        60,
      );
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkFeatureGate', () => {
    it('returns false for outbound on free because browser tests are not PSTN calls', async () => {
      const prisma = makePrisma({ subscription: { plan: 'free', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'outbound');
      expect(result).toBe(false);
    });

    it('returns true for outbound on starter plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'outbound');
      expect(result).toBe(true);
    });

    it('returns false for white_label on starter plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'white_label');
      expect(result).toBe(false);
    });

    it('returns true for white_label on growth plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'growth', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.checkFeatureGate('org-fake', 'white_label');
      expect(result).toBe(true);
    });

    it('returns true for analytics on any paid plan', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const svc = makeService(prisma);
      expect(await svc.checkFeatureGate('org-fake', 'analytics')).toBe(true);
      expect(await svc.checkFeatureGate('org-fake', 'bulk_import')).toBe(true);
      expect(await svc.checkFeatureGate('org-fake', 'api_access')).toBe(true);
    });

    it('keeps tools and BYO telephony behind paid plans', async () => {
      const free = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));
      const starter = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      expect(await free.checkFeatureGate('org-fake', 'tools')).toBe(false);
      expect(await free.checkFeatureGate('org-fake', 'byo_telephony')).toBe(false);
      expect(await starter.checkFeatureGate('org-fake', 'tools')).toBe(true);
      expect(await starter.checkFeatureGate('org-fake', 'byo_telephony')).toBe(true);
    });

    /**
     * Provisioning a carrier number spends platform money every month for as
     * long as the number is held, so an unfunded organization must never reach
     * the purchase. `paid_but_unfunded` is the case that matters: the plan name
     * says growth, nothing is paying for it.
     */
    it('keeps managed telephony behind a funded paid plan', async () => {
      const free = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));
      const noSubscription = makeService(makePrisma({ subscription: null }));
      const pastDue = makeService(
        makePrisma({ subscription: { plan: 'growth', status: 'past_due' } }),
      );
      const starter = makeService(makePrisma({ subscription: { plan: 'starter', status: 'active' } }));

      expect(await free.checkFeatureGate('org-fake', 'managed_telephony')).toBe(false);
      expect(await noSubscription.checkFeatureGate('org-fake', 'managed_telephony')).toBe(false);
      expect(await pastDue.checkFeatureGate('org-fake', 'managed_telephony')).toBe(false);
      expect(await starter.checkFeatureGate('org-fake', 'managed_telephony')).toBe(true);
    });

    it('treats expired trialing as free plan for feature gates', async () => {
      const expiredTrial = new Date(Date.now() - 86400000); // yesterday
      const prisma = makePrisma({
        subscription: { plan: 'trialing', status: 'trialing', trialEnd: expiredTrial },
      });
      const svc = makeService(prisma);
      expect(await svc.checkFeatureGate('org-fake', 'outbound')).toBe(false);
      expect(await svc.checkFeatureGate('org-fake', 'analytics')).toBe(false);
      expect(await svc.checkFeatureGate('org-fake', 'white_label')).toBe(false);
    });

    it('treats active trialing as paid plan for feature gates', async () => {
      const futureTrial = new Date(Date.now() + 86400000); // tomorrow
      const prisma = makePrisma({
        subscription: { plan: 'starter', status: 'trialing', trialEnd: futureTrial },
      });
      const svc = makeService(prisma);
      expect(await svc.checkFeatureGate('org-fake', 'outbound')).toBe(true);
      expect(await svc.checkFeatureGate('org-fake', 'analytics')).toBe(true);
    });
  });

  describe('checkAgentCreationWarning', () => {
    it('returns null warning when far below 80% threshold', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' }, agentCount: 0 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).toBeNull();
      expect(result.current).toBe(0);
      expect(result.limit).toBe(3);
    });

    it('returns warning at 80% for starter (2/3 agents)', async () => {
      // starter has 3 agents, 80% = floor(2.4) = 2, so 2 >= 2 && 2 <= 3 → warning
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' }, agentCount: 2 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('2/3');
      expect(result.current).toBe(2);
    });

    it('returns warning at 80% for free plan (1/1 agents)', async () => {
      // free has 1 agent, 80% = floor(0.8) = 0, so 1 >= 0 && 1 <= 1 → warning (at 100% of limit)
      const prisma = makePrisma({ subscription: { plan: 'free', status: 'active' }, agentCount: 1 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain('1/1');
      expect(result.current).toBe(1);
    });

    it('returns a warning when enterprise reaches its 30-agent contract quota', async () => {
      const prisma = makePrisma({ subscription: { plan: 'enterprise', status: 'active' }, agentCount: 30 });
      const svc = makeService(prisma);
      const result = await svc.checkAgentCreationWarning('org-fake');
      expect(result.warning).toContain('30/30');
      expect(result.limit).toBe(30);
    });
  });

  describe('enforceAgentLimit', () => {
    it('counts only published agents when enforcing publish limits', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'free', status: 'active' },
        agentCount: 0,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).resolves.toBeUndefined();
      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { workspace: { organizationId: 'org-fake' }, status: 'published' },
      });
    });

    it('throws ForbiddenPlanError when at limit (free, 1 agent)', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'free', status: 'active' },
        agentCount: 1,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).rejects.toBeInstanceOf(ForbiddenPlanError);
    });

    it('does not throw when below limit', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'free', status: 'active' },
        agentCount: 0,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).resolves.toBeUndefined();
    });

    it('throws when enterprise reaches its 30-agent contract quota', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'enterprise', status: 'active' },
        agentCount: 30,
      });
      const svc = makeService(prisma);
      await expect(svc.enforceAgentLimit('org-fake')).rejects.toBeInstanceOf(ForbiddenPlanError);
    });
  });

  describe('recordUsage', () => {
    it('creates a UsageRecord with calls metric', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await svc.recordUsage('ws-1', 'calls', 1);
      expect(prisma.usageRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-1',
            billableMetric: 'calls',
            quantity: 1,
          }),
        }),
      );
    });

    it('creates a UsageRecord with minutes metric', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);
      await svc.recordUsage('ws-1', 'minutes', 5);
      expect(prisma.usageRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billableMetric: 'minutes',
            quantity: 5,
          }),
        }),
      );
    });
  });

  describe('getWorkspaceUsage', () => {
    it('returns zero metrics when no call has been metered', async () => {
      const prisma = makePrisma({ subscription: { plan: 'free', status: 'active' } });
      const svc = makeService(prisma);
      const result = await svc.getWorkspaceUsage('ws-1');
      expect(result.workspaceId).toBe('ws-1');
      expect(result.usage.calls).toBe(0);
      expect(result.usage.minutes).toBe(0);
      expect(result.limits.calls).toBeUndefined();
    });

    /**
     * Prod 2026-09-02: five completed calls and 600 s of debited credit, and a
     * usage panel that read 0 / 0 because it looked at `usage_records`, which
     * nothing on the LiveKit path writes. The panel has to report from the same
     * ledger the customer is charged from.
     */
    it('reports connected calls and billed minutes from the call usage ledger', async () => {
      const connectedAt = new Date();
      const prisma = makePrisma({
        subscription: { plan: 'starter', status: 'active' },
        usageRecords: [],
        callUsages: [
          { connectedAt, billableSeconds: 540 },
          { connectedAt, billableSeconds: 60 },
          // Never connected: a minute boundary can increment a row before the
          // connected event stamps it, so its seconds must not count either.
          { connectedAt: null, billableSeconds: 60 },
        ],
        agentCount: 2,
        integrationToolCount: 3,
      });
      const svc = makeService(prisma);
      const result = await svc.getWorkspaceUsage('ws-1');
      expect(result.usage).toEqual({ calls: 2, minutes: 10, agents: 2, tools: 3 });
      expect(result.metrics).toEqual(result.usage);
      expect(result.limits.minutes).toBe(200);
      expect(prisma.usageRecord.findMany).not.toHaveBeenCalled();
    });

    it('only counts usage rows created inside the requested period', async () => {
      const prisma = makePrisma({ subscription: { plan: 'starter', status: 'active' } });
      const rows = [
        { createdAt: new Date('2026-09-02T13:19:02Z'), connectedAt: new Date(), billableSeconds: 540 },
        { createdAt: new Date('2026-08-25T14:27:56Z'), connectedAt: new Date(), billableSeconds: 60 },
      ];
      // findMany honours the createdAt predicate so the test defends the
      // predicate rather than a stub's return value.
      prisma.callUsage.findMany = vi.fn(async (args: unknown) => {
        const { gte, lte } = (args as { where: { createdAt: { gte: Date; lte: Date } } }).where
          .createdAt;
        return rows.filter((r) => r.createdAt >= gte && r.createdAt <= lte);
      }) as never;
      const svc = makeService(prisma);

      const result = await svc.getWorkspaceUsage(
        'ws-1',
        new Date('2026-09-01T00:00:00Z'),
        new Date('2026-09-30T23:59:59Z'),
      );
      expect(result.usage.calls).toBe(1);
      expect(result.usage.minutes).toBe(9);
    });
  });

  describe('canStartOutboundCall', () => {
    it('does not treat connected call history as a paid-plan call-count allowance', async () => {
      const prisma = makePrisma({
        subscription: { plan: 'starter', status: 'active' },
        usageRecords: [{ billableMetric: 'calls', quantity: 2, periodStart: new Date(), periodEnd: new Date() }],
      });
      const svc = makeService(prisma);

      await expect(svc.canStartOutboundCall('ws-1')).resolves.toEqual({ allowed: true });
    });

    it('denies Free PSTN calls even though it has a browser-test entitlement', async () => {
      const svc = makeService(makePrisma({ subscription: { plan: 'free', status: 'active' } }));

      await expect(svc.canStartOutboundCall('ws-1')).resolves.toEqual({ allowed: false });
    });
  });
});
