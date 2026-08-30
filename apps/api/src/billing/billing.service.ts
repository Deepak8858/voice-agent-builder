import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import type {
  CheckoutPlan,
  BillingStatusDto,
  BillingSummaryDto,
  CreateCheckoutSessionDto,
  CreatePortalSessionDto,
  CreateTopUpCheckoutDto,
  EntitlementReason,
  FeatureGate,
  InvoiceDto,
  PlanType,
  SubscriptionDto,
  SubscriptionStatus,
  WorkspaceUsageDto,
} from '@voiceforge/shared';
import {
  BILLING_CATALOG_VERSION,
  hasLiveSubscription,
  isCheckoutPlan,
  PAID_CALL_MINIMUM_SECONDS,
  PLAN_LIMITS as SHARED_PLAN_LIMITS,
} from '@voiceforge/shared';
import type { ApiErrorCode } from '@voiceforge/shared';
import { AppError } from '../common/errors';
import { CacheService } from '../cache/cache.service';
import {
  STRIPE_PORTAL_REQUIRED_ENV,
  STRIPE_SUBSCRIPTION_REQUIRED_ENV,
  STRIPE_TOPUP_REQUIRED_ENV,
  type StripeEnvName,
  env,
  missingStripeEnv,
} from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { EntitlementService } from './entitlement.service';

interface StripeCustomer {
  id: string;
}

interface StripeSession {
  url: string | null;
}

interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  created: number;
  period_start?: number | null;
  period_end?: number | null;
  invoice_pdf?: string | null;
  hosted_invoice_url?: string | null;
}

interface StripeClient {
  customers: {
    create(params: Record<string, unknown>): Promise<StripeCustomer>;
  };
  checkout: {
    sessions: {
      create(
        params: Record<string, unknown>,
        options?: { idempotencyKey?: string },
      ): Promise<StripeSession>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Record<string, unknown>): Promise<StripeSession>;
    };
  };
  invoices: {
    list(params: Record<string, unknown>): Promise<{ data: StripeInvoice[] }>;
  };
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) <= 31);
}

const CHECKOUT_UNCONFIGURED_MESSAGE =
  'Stripe checkout is temporarily unavailable. No plan change was made and no free allowance was granted.';
const STRIPE_TEMPORARY_FAILURE_MESSAGE =
  'Checkout is temporarily unavailable. No plan change was made. Please try again in a few minutes.';
const SUBSCRIPTION_CACHE_TTL_SECONDS = 60;
const NO_SUBSCRIPTION = '__none__';

type CachedSubscription = SubscriptionDto | typeof NO_SUBSCRIPTION;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly stripe: StripeClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly creditLedger: CreditLedgerService,
    @Optional() private readonly cache?: CacheService,
  ) {
    // Pin to the version the installed SDK was built for rather than a
    // duplicated literal, and retry transient network failures so a dropped
    // connection does not surface as a failed payment attempt.
    this.stripe = env.STRIPE_SECRET_KEY
      ? (new Stripe(env.STRIPE_SECRET_KEY, {
          apiVersion: Stripe.API_VERSION,
          maxNetworkRetries: 2,
        }) as unknown as StripeClient)
      : null;
    if (!this.stripe) {
      this.logger.warn('STRIPE_SECRET_KEY is not set. Stripe operations will be no-ops.');
    }
  }

  // -------------------------------------------------------------------------
  // Customer management
  // -------------------------------------------------------------------------

  getBillingStatus(): BillingStatusDto {
    const liveCheckoutEnabled = this.isStripeConfigured(STRIPE_SUBSCRIPTION_REQUIRED_ENV);
    const topUpEnabled = this.isStripeConfigured(STRIPE_TOPUP_REQUIRED_ENV);
    const portalEnabled = this.isStripeConfigured(STRIPE_PORTAL_REQUIRED_ENV);
    return {
      liveCheckoutEnabled,
      topUpEnabled,
      portalEnabled,
      message:
        liveCheckoutEnabled && topUpEnabled && portalEnabled
          ? 'Live Stripe checkout and customer portal actions are enabled.'
          : CHECKOUT_UNCONFIGURED_MESSAGE,
    };
  }

  async getOrCreateCustomer(organizationId: string): Promise<string> {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });
    if (sub?.stripeCustomerId) return sub.stripeCustomerId;

    if (!this.stripe) {
      throw new InternalServerErrorException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY before calling billing endpoints.',
      );
    }

    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true },
    });
    const customer = await this.stripe.customers.create({
      metadata: { organizationId },
      name: org.name,
    });
    await this.prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        stripeCustomerId: customer.id,
        plan: 'free',
        status: 'active',
      },
      update: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }

  // -------------------------------------------------------------------------
  // Checkout & portal
  // -------------------------------------------------------------------------

  async createCheckoutSession(
    organizationId: string,
    dto: CreateCheckoutSessionDto,
    actorUserId: string,
  ): Promise<{ url: string }> {
    this.assertStripeConfigured(STRIPE_SUBSCRIPTION_REQUIRED_ENV);
    if (!this.stripe) throw new InternalServerErrorException('Stripe is not configured.');
    // Enterprise is sales-assisted; it has no self-service Price and must never
    // be reachable from a client-supplied plan value.
    if (!isCheckoutPlan(dto.plan)) {
      throw new BadRequestException('This plan is not available for self-service checkout.');
    }
    // Refuse to start a second subscription while one is live. Stripe would
    // happily create it, the customer would be billed twice, and
    // `checkout.session.completed` can only record one subscription id — the
    // other keeps billing with nothing here able to resolve or cancel it.
    const existing = await this.prisma.subscription.findUnique({
      where: { organizationId },
      select: { stripeSubscriptionId: true, status: true },
    });
    if (existing?.stripeSubscriptionId && hasLiveSubscription(existing.status)) {
      throw new BadRequestException(
        'This organization already has a subscription. Change or cancel it from the billing portal instead.',
      );
    }
    const customerId = await this.getOrCreateCustomer(organizationId);
    const priceId = this.getPriceIdForPlan(dto.plan);
    const successUrl = this.withCheckoutSessionId(this.buildAppUrl(dto.successPath));
    const cancelUrl = this.buildAppUrl(dto.cancelPath);
    const integrationIdentifier = this.newIntegrationIdentifier();
    const session = await this.createStripeCheckoutSession({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Tax collection stays off until the tax registrations are confirmed;
      // enabling it before then makes Stripe reject otherwise valid sessions.
      automatic_tax: { enabled: env.STRIPE_TAX_ENABLED },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      metadata: {
        organizationId,
        plan: dto.plan,
        catalogVersion: BILLING_CATALOG_VERSION,
        integration_identifier: integrationIdentifier,
      },
      subscription_data: {
        metadata: { organizationId, plan: dto.plan, catalogVersion: BILLING_CATALOG_VERSION },
      },
    }, dto.idempotencyKey);
    if (!session.url) throw new InternalServerErrorException('Stripe returned no URL.');
    await this.logBillingAudit(organizationId, actorUserId, 'billing.checkout_started', {
      plan: dto.plan,
      priceId,
      stripeCustomerId: customerId,
      integrationIdentifier,
    });
    return { url: session.url };
  }

  /**
   * Prepaid 100-minute pack. Extra usage is prepaid only, so this is a one-time
   * `payment` session against a server-owned Price; the client never supplies a
   * Price ID or an amount. Only an organization with paid access may buy one,
   * because packs are consumed after included minutes.
   */
  async createTopUpCheckoutSession(
    organizationId: string,
    dto: CreateTopUpCheckoutDto,
    actorUserId: string,
  ): Promise<{ url: string }> {
    this.assertStripeConfigured(STRIPE_TOPUP_REQUIRED_ENV);
    if (!this.stripe) throw new InternalServerErrorException('Stripe is not configured.');
    const priceId = env.STRIPE_MINUTE_PACK_PRICE_ID;
    if (!priceId) {
      throw new BillingUnavailableError(CHECKOUT_UNCONFIGURED_MESSAGE);
    }

    const effective = await this.entitlements.getEffectivePlan(organizationId);
    if (!effective.paidAccess) {
      throw new ForbiddenPlanError(
        'Minute packs are available on a paid plan with an active subscription.',
        {
          reason:
            effective.status === 'active' || effective.status === 'none'
              ? 'subscription_required'
              : 'subscription_inactive',
          plan: effective.plan,
          catalogVersion: effective.catalogVersion,
        },
      );
    }

    const customerId = await this.getOrCreateCustomer(organizationId);
    const integrationIdentifier = this.newIntegrationIdentifier();
    const session = await this.createStripeCheckoutSession({
      customer: customerId,
      mode: 'payment',
      // Card only, deliberately. A delayed-notification method (ACH, SEPA debit,
      // Bacs) completes Checkout with `payment_status: 'unpaid'` and settles days
      // later on `checkout.session.async_payment_succeeded`, which we do not
      // subscribe to — so the pack would be paid for and never granted. Unlike a
      // subscription, whose credit is granted from `invoice.paid` whenever the
      // money actually clears, a one-time pack has no such later proof.
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: this.withCheckoutSessionId(this.buildAppUrl(dto.successPath)),
      cancel_url: this.buildAppUrl(dto.cancelPath),
      automatic_tax: { enabled: env.STRIPE_TAX_ENABLED },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      metadata: {
        organizationId,
        purchaseType: 'minute_pack',
        catalogVersion: BILLING_CATALOG_VERSION,
        integration_identifier: integrationIdentifier,
      },
      payment_intent_data: {
        metadata: {
          organizationId,
          purchaseType: 'minute_pack',
          catalogVersion: BILLING_CATALOG_VERSION,
        },
      },
    }, dto.idempotencyKey);
    if (!session.url) throw new InternalServerErrorException('Stripe returned no URL.');
    await this.logBillingAudit(organizationId, actorUserId, 'billing.topup_checkout_started', {
      priceId,
      stripeCustomerId: customerId,
      catalogVersion: BILLING_CATALOG_VERSION,
      integrationIdentifier,
    });
    return { url: session.url };
  }

  /**
   * Correlates one Checkout attempt across our audit log and Stripe's dashboard
   * without exposing anything about the organization.
   */
  private newIntegrationIdentifier(): string {
    return `vf_${randomBytes(12).toString('hex')}`;
  }

  /**
   * Single Stripe Checkout call site, so every self-service payment path maps a
   * Stripe failure the same way instead of letting a raw `StripeError` reach the
   * global filter, which masks it to "Unexpected server error." in production.
   */
  private async createStripeCheckoutSession(
    params: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<StripeSession> {
    if (!this.stripe) throw new InternalServerErrorException('Stripe is not configured.');
    try {
      return await this.stripe.checkout.sessions.create(params, { idempotencyKey });
    } catch (error) {
      this.throwMappedStripeError(error);
    }
  }

  /**
   * Turns a Stripe failure into a real HTTP response.
   *
   * Card and invalid-request errors describe something the account owner can act
   * on — a declined card, or an account restriction such as an unregistered
   * Indian business that cannot accept international payments. Stripe's own
   * message is the actionable detail, so it is surfaced with a 400.
   *
   * Authentication, permission, rate-limit, connection and API errors are either
   * our own configuration or a transient Stripe outage, so the caller is told
   * checkout is unavailable without leaking the internal cause.
   *
   * A non-Stripe error is re-thrown unchanged.
   */
  private throwMappedStripeError(error: unknown): never {
    if (error instanceof Stripe.errors.StripeError) {
      // Mapping to a 4xx stops the global filter from mirroring this to error
      // tracking, so this log line is the record ops keeps of the real cause.
      this.logger.warn(
        `Stripe rejected a checkout request: type=${error.type} code=${error.code ?? 'none'} requestId=${error.requestId ?? 'none'}`,
      );
      if (
        error instanceof Stripe.errors.StripeCardError ||
        error instanceof Stripe.errors.StripeInvalidRequestError
      ) {
        throw new BadRequestException(error.message);
      }
      throw new BillingUnavailableError(STRIPE_TEMPORARY_FAILURE_MESSAGE);
    }
    throw error;
  }

  async createPortalSession(
    organizationId: string,
    dto: CreatePortalSessionDto,
    actorUserId: string,
  ): Promise<{ url: string }> {
    this.assertStripeConfigured(STRIPE_PORTAL_REQUIRED_ENV);
    if (!this.stripe) throw new InternalServerErrorException('Stripe is not configured.');
    const customerId = await this.getOrCreateCustomer(organizationId);
    const returnUrl = this.buildAppUrl(dto.returnPath);
    // Without a configuration the portal shows Stripe's *account default*
    // feature set, which is whatever was last clicked in the dashboard rather
    // than something this product controls. Optional on purpose: an unset id
    // must not disable the portal, because a customer locked out of the portal
    // cannot fix a failing card, and that turns a config gap into churn. Hence
    // it is also absent from STRIPE_PORTAL_REQUIRED_ENV.
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(env.STRIPE_PORTAL_CONFIGURATION_ID
        ? { configuration: env.STRIPE_PORTAL_CONFIGURATION_ID }
        : {}),
    });
    if (!session.url) throw new InternalServerErrorException('Stripe returned no portal URL.');
    await this.logBillingAudit(organizationId, actorUserId, 'billing.portal_opened', {
      stripeCustomerId: customerId,
    });
    return { url: session.url };
  }

  private getPriceIdForPlan(plan: CheckoutPlan): string {
    const priceIds: Record<CheckoutPlan, string | undefined> = {
      starter: env.STRIPE_STARTER_PRICE_ID,
      growth: env.STRIPE_GROWTH_PRICE_ID,
    };
    const priceId = priceIds[plan];
    if (!priceId) {
      throw new InternalServerErrorException(`Stripe price ID is not configured for ${plan}.`);
    }
    return priceId;
  }

  /**
   * Each entry point fails closed on its own configuration, and only its own: a
   * deployment without STRIPE_MINUTE_PACK_PRICE_ID cannot sell packs but must
   * still take subscription payments and open the portal, because one unset
   * price ID used to 503 all three. Still fails closed — a partially configured
   * deployment never sends a customer to Stripe it cannot then settle with, and
   * never invents a free allowance. The lists live in config/env so these gates,
   * the boot refinement and the deploy gate cannot drift apart.
   */
  private assertStripeConfigured(required: readonly StripeEnvName[]): void {
    if (!this.isStripeConfigured(required)) {
      throw new BillingUnavailableError(CHECKOUT_UNCONFIGURED_MESSAGE);
    }
  }

  private isStripeConfigured(required: readonly StripeEnvName[]): boolean {
    return Boolean(this.stripe) && missingStripeEnv(required, env).length === 0;
  }

  private buildAppUrl(path: string): string {
    this.assertSafeRelativePath(path);
    return new URL(path, env.WEB_BASE_URL).toString();
  }

  private assertSafeRelativePath(path: string): void {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      hasControlCharacter(path)
    ) {
      throw new BadRequestException('Invalid redirect path');
    }
  }

  private withCheckoutSessionId(url: string): string {
    return `${url}${url.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;
  }

  /**
   * `actorUserId` is required, not optional: every one of these three actions is
   * started by a signed-in owner or admin, and the rows were being written with
   * a null actor — so an audit log that exists to answer "who moved the money"
   * could not answer it for the routes that move the most. It is threaded from
   * `@CurrentUser()` in the controller, the same way ~15 other modules do it,
   * and never taken from the request body, which the caller controls.
   *
   * `ipAddress`/`userAgent` stay unset because no non-test caller anywhere in
   * this API supplies them; adding them here alone would only make this module's
   * rows look different, not more traceable.
   */
  private async logBillingAudit(
    organizationId: string,
    actorUserId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId,
        action,
        resourceType: 'subscription',
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  async getSubscription(organizationId: string): Promise<SubscriptionDto | null> {
    const cacheKey = `billing:subscription:${organizationId}`;
    const cached = await this.cache?.get<CachedSubscription>(cacheKey);
    if (cached === NO_SUBSCRIPTION) return null;
    if (cached) return cached;

    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });
    if (!sub) {
      await this.cache?.set(cacheKey, NO_SUBSCRIPTION, SUBSCRIPTION_CACHE_TTL_SECONDS);
      return null;
    }
    const dto: SubscriptionDto = {
      id: sub.id,
      plan: sub.plan as PlanType,
      status: sub.status as SubscriptionStatus,
      currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      trialEnd: sub.trialEnd?.toISOString() ?? null,
      stripeCustomerId: sub.stripeCustomerId,
    };
    await this.cache?.set(cacheKey, dto, SUBSCRIPTION_CACHE_TTL_SECONDS);
    return dto;
  }

  /**
   * Organization-wide billing state. Quotas, credit, and usage counts are all
   * organization-scoped, so opening this from any workspace of the same
   * organization returns the same numbers; a workspace is never a billing
   * boundary.
   */
  async getBillingSummary(organizationId: string): Promise<BillingSummaryDto> {
    // The plan is resolved once and handed to the entitlement check, so the
    // summary reports one consistent commercial state instead of two reads that
    // can straddle a subscription change.
    const effective = await this.entitlements.getEffectivePlan(organizationId);
    const [subscription, credit, usage, callDecision] = await Promise.all([
      this.getSubscription(organizationId),
      this.creditLedger.getCreditSummary(organizationId),
      this.getOrganizationUsageCounts(organizationId),
      this.entitlements.check(
        organizationId,
        { kind: 'paid_call', minimumSeconds: PAID_CALL_MINIMUM_SECONDS },
        effective,
      ),
    ]);

    return {
      organizationId,
      plan: effective.plan,
      status: effective.status,
      paidAccess: effective.paidAccess,
      catalogVersion: effective.catalogVersion,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      includedSeconds: credit.includedSeconds,
      purchasedSeconds: credit.purchasedSeconds,
      reservedSeconds: credit.reservedSeconds,
      expiringSeconds: credit.expiringSeconds,
      topUpAvailable: effective.paidAccess,
      availableSeconds: credit.availableSeconds,
      balanceStatus: credit.status,
      entitlements: {
        includedMinutes: effective.entitlements.includedMinutes,
        agents: effective.entitlements.agents,
        workspaces: effective.entitlements.workspaces,
        nangoConnections: effective.entitlements.nangoConnections,
        concurrentCalls: effective.entitlements.concurrentCalls,
        outboundPstn: effective.entitlements.outboundPstn,
        campaigns: effective.entitlements.campaigns,
        whiteLabel: effective.entitlements.whiteLabel,
        // Which runtimes this plan's calls may use. Surfaced so the dashboard
        // can explain why a free workspace never reaches the realtime model.
        pipelineMix: effective.entitlements.pipelineMix,
      },
      usage,
      // The reason a paid call would be refused right now is the one the
      // customer needs to act on, and it comes from the same decision path the
      // runtime uses rather than a second copy of the rules.
      blockedReason: callDecision.reason as EntitlementReason,
    };
  }

  private async getOrganizationUsageCounts(
    organizationId: string,
  ): Promise<{ agents: number; workspaces: number; integrations: number }> {
    const [agents, workspaces, integrations] = await Promise.all([
      this.prisma.agent.count({ where: { workspace: { organizationId } } }),
      this.prisma.workspace.count({ where: { organizationId } }),
      this.prisma.integrationTool.count({ where: { organizationId } }),
    ]);
    return { agents, workspaces, integrations };
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  async getWorkspaceUsage(
    workspaceId: string,
    periodStart?: Date,
    periodEnd?: Date,
  ): Promise<WorkspaceUsageDto> {
    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const now = new Date();
    const start = periodStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const end = periodEnd ?? now;

    const records = await this.prisma.usageRecord.findMany({
      where: {
        workspaceId,
        // recordUsage stamps periodEnd at the end of the month, so every row for
        // the period in progress ends after `end` and containment matched none of
        // them: the panel read zero for every customer. A row counts when its
        // period overlaps the requested window.
        periodStart: { lte: end },
        periodEnd: { gte: start },
      },
    });

    const metrics: Record<string, number> = { calls: 0, minutes: 0, tools: 0, agents: 0 };
    for (const r of records) {
      metrics[r.billableMetric] = (metrics[r.billableMetric] ?? 0) + r.quantity;
    }

    const sub = await this.getSubscription(ws.organizationId);
    const plan = (sub?.plan ?? 'free') as keyof typeof SHARED_PLAN_LIMITS;
    const limits = SHARED_PLAN_LIMITS[plan];
    const usage = { calls: metrics.calls ?? 0, minutes: metrics.minutes ?? 0, tools: metrics.tools ?? 0, agents: metrics.agents ?? 0 };

    return {
      workspaceId,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      metrics,
      limits: {
        minutes: limits.minutes,
        tools: limits.tools,
        agents: limits.agents,
      },
      usage,
    };
  }

  async recordUsage(
    workspaceId: string,
    metric: 'calls' | 'minutes' | 'tools' | 'agents',
    quantity: number,
  ): Promise<void> {
    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    await this.prisma.usageRecord.create({
      data: {
        organizationId: ws.organizationId,
        workspaceId,
        billableMetric: metric,
        quantity,
        periodStart: startOfMonth,
        periodEnd: endOfMonth,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Feature gates
  // -------------------------------------------------------------------------

  /**
   * Compatibility wrapper. The decision itself belongs to EntitlementService so
   * a single policy governs every caller; only the boolean shape is preserved
   * for existing consumers.
   */
  async checkFeatureGate(
    organizationId: string,
    gate: FeatureGate,
  ): Promise<boolean> {
    const effective = await this.entitlements.getEffectivePlan(organizationId);
    const { entitlements, paidAccess, plan } = effective;

    switch (gate) {
      case 'outbound':
        return entitlements.outboundPstn && paidAccess;
      // Compliance blocking is a mandatory safety control on every plan, so it
      // is read from its own entitlement rather than inherited from campaigns.
      case 'compliance_blocks':
        return entitlements.complianceBlocks;
      case 'white_label':
        return entitlements.whiteLabel;
      case 'multiple_workspaces':
        return entitlements.workspaces > 1;
      case 'tools':
        return entitlements.nangoConnections > 0;
      // Both telephony gates are "paid plans only" rather than
      // `entitlements.outboundPstn`: a carrier number is mainly an *inbound*
      // capability, so deriving it from the outbound flag would refuse a plan
      // sold inbound-only. No plan in the catalog differs today.
      case 'byo_telephony':
      case 'managed_telephony':
      case 'ai_insights':
      case 'api_access':
      case 'bulk_import':
      case 'analytics':
        return plan !== 'free' && paidAccess;
      default:
        return false;
    }
  }

  async canPublishAgent(organizationId: string, currentAgentCount: number): Promise<boolean> {
    const decision = await this.entitlements.check(organizationId, {
      kind: 'agent_create',
      current: currentAgentCount,
    });
    return decision.allowed;
  }

  async canOutboundCall(organizationId: string, currentConcurrentCallCount: number): Promise<boolean> {
    const effective = await this.entitlements.getEffectivePlan(organizationId);
    return (
      effective.entitlements.outboundPstn &&
      effective.paidAccess &&
      currentConcurrentCallCount < effective.entitlements.concurrentCalls
    );
  }

  /**
   * Whether the organization behind this workspace may attempt a paid PSTN call
   * at all. Credit and concurrency admission happen later in the call path; this
   * is only the plan-level gate.
   */
  async canStartOutboundCall(workspaceId: string): Promise<{ allowed: boolean }> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const effective = await this.entitlements.getEffectivePlan(workspace.organizationId);
    return { allowed: effective.entitlements.outboundPstn && effective.paidAccess };
  }

  async enforceAgentLimit(organizationId: string): Promise<void> {
    const count = await this.prisma.agent.count({
      where: { workspace: { organizationId }, status: 'published' },
    });
    const decision = await this.entitlements.check(organizationId, {
      kind: 'agent_create',
      current: count,
    });
    if (!decision.allowed) {
      throw new ForbiddenPlanError(
        `Your ${decision.plan} plan allows ${decision.limit} published agents. Please upgrade to publish more.`,
        {
          reason: decision.reason,
          current: decision.current,
          limit: decision.limit,
          catalogVersion: decision.catalogVersion,
          correlationId: decision.correlationId,
        },
      );
    }
  }

  async checkAgentCreationWarning(organizationId: string): Promise<{ warning: string | null; current: number; limit: number }> {
    const effective = await this.entitlements.getEffectivePlan(organizationId);
    const limit = effective.entitlements.agents;
    const current = await this.prisma.agent.count({ where: { workspace: { organizationId } } });
    const threshold = Math.floor(limit * 0.8);
    if (current >= threshold && current <= limit) {
      return {
        warning: `You have ${current}/${limit} agents (${Math.round((current / limit) * 100)}% of your plan limit). Upgrade to publish more agents.`,
        current,
        limit,
      };
    }
    return { warning: null, current, limit };
  }

  async getInvoices(stripeCustomerId: string): Promise<{ items: InvoiceDto[] }> {
    if (!this.stripe) return { items: [] };
    const invoices = await this.stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 12,
    });
    return {
      items: invoices.data.map((inv) => ({
        id: inv.id,
        number: inv.number ?? null,
        status: inv.status ?? null,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        currency: inv.currency,
        created: inv.created,
        periodStart: inv.period_start ?? inv.created,
        periodEnd: inv.period_end ?? inv.created,
        invoicePdf: inv.invoice_pdf ?? null,
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      })),
    };
  }
}

export class ForbiddenPlanError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PLAN_LIMIT_EXCEEDED' as ApiErrorCode, message, HttpStatus.FORBIDDEN, details);
  }
}

export class BillingUnavailableError extends AppError {
  constructor(message: string) {
    super('BILLING_UNAVAILABLE' as ApiErrorCode, message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
