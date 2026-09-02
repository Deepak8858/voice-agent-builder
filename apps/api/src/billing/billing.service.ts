import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import DodoPayments, { APIError } from 'dodopayments';
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
  DODO_PORTAL_REQUIRED_ENV,
  DODO_SUBSCRIPTION_REQUIRED_ENV,
  DODO_TOPUP_REQUIRED_ENV,
  type DodoEnvName,
  env,
  missingDodoEnv,
} from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { EntitlementService } from './entitlement.service';

/**
 * The only SDK surface this service calls, derived from `DodoPayments` rather
 * than hand-rolled: every parameter and return shape below is the installed
 * SDK's, so a renamed resource or a changed Checkout parameter is a compile
 * error here instead of a runtime failure in the middle of a payment.
 *
 * There is no `billingPortal` twin: the portal hangs off the customer
 * (`customers.customerPortal`), and as a Merchant of Record Dodo owns tax and
 * the portal's feature set, so neither `automatic_tax` nor a portal
 * configuration object has an equivalent here.
 */
type DodoClient = Pick<DodoPayments, 'customers' | 'checkoutSessions' | 'payments'>;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) <= 31);
}

/**
 * The `code` Dodo puts in a 4xx body (`{"code":"MERCHANT_NOT_LIVE"}`), for the
 * log line and the 503 message. Anything else is reported as unknown rather than
 * echoed, so an unexpected body shape cannot become the customer-facing string.
 */
function dodoErrorCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown';
}

const CHECKOUT_UNCONFIGURED_MESSAGE =
  'Checkout is temporarily unavailable. No plan change was made and no free allowance was granted.';
const SUBSCRIPTION_CACHE_TTL_SECONDS = 60;
const NO_SUBSCRIPTION = '__none__';

type CachedSubscription = SubscriptionDto | typeof NO_SUBSCRIPTION;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly dodo: DodoClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly creditLedger: CreditLedgerService,
    @Optional() private readonly cache?: CacheService,
  ) {
    // `environment` selects the base URL, so test-mode keys can never reach the
    // live host. `maxRetries` retries transient network failures so a dropped
    // connection does not surface as a failed payment attempt.
    this.dodo = env.DODO_PAYMENTS_API_KEY
      ? new DodoPayments({
          bearerToken: env.DODO_PAYMENTS_API_KEY,
          environment: env.DODO_PAYMENTS_ENVIRONMENT,
          maxRetries: 2,
        })
      : null;
    if (!this.dodo) {
      this.logger.warn('DODO_PAYMENTS_API_KEY is not set. Dodo operations will be no-ops.');
    }
  }

  // -------------------------------------------------------------------------
  // Customer management
  // -------------------------------------------------------------------------

  getBillingStatus(): BillingStatusDto {
    const liveCheckoutEnabled = this.isDodoConfigured(DODO_SUBSCRIPTION_REQUIRED_ENV);
    const topUpEnabled = this.isDodoConfigured(DODO_TOPUP_REQUIRED_ENV);
    const portalEnabled = this.isDodoConfigured(DODO_PORTAL_REQUIRED_ENV);
    return {
      liveCheckoutEnabled,
      topUpEnabled,
      portalEnabled,
      message:
        liveCheckoutEnabled && topUpEnabled && portalEnabled
          ? 'Live checkout and customer portal actions are enabled.'
          : CHECKOUT_UNCONFIGURED_MESSAGE,
    };
  }

  async getOrCreateCustomer(organizationId: string): Promise<string> {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });
    if (sub?.dodoCustomerId) return sub.dodoCustomerId;

    const dodo = this.dodo;
    if (!dodo) {
      throw new InternalServerErrorException(
        'Dodo Payments is not configured. Set DODO_PAYMENTS_API_KEY before calling billing endpoints.',
      );
    }

    // `email` is required by Dodo (Stripe's customers.create was not), and the
    // owner's address is the only billing contact this product stores. Creating
    // the customer here rather than letting the hosted page mint one keeps the
    // customer -> organization mapping in place *before* checkout, which is what
    // the webhook resolves a subscription's owner from when the delivery carries
    // no metadata.
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true, owner: { select: { email: true } } },
    });
    const customer = await this.callDodo('customers.create', () =>
      dodo.customers.create({
        email: org.owner.email,
        name: org.name,
        metadata: { organizationId },
      }),
    );
    await this.prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        dodoCustomerId: customer.customer_id,
        plan: 'free',
        status: 'active',
      },
      update: { dodoCustomerId: customer.customer_id },
    });
    return customer.customer_id;
  }

  // -------------------------------------------------------------------------
  // Checkout & portal
  // -------------------------------------------------------------------------

  async createCheckoutSession(
    organizationId: string,
    dto: CreateCheckoutSessionDto,
    actorUserId: string,
  ): Promise<{ url: string }> {
    this.assertDodoConfigured(DODO_SUBSCRIPTION_REQUIRED_ENV);
    const dodo = this.dodo;
    if (!dodo) throw new InternalServerErrorException('Dodo Payments is not configured.');
    // Enterprise is sales-assisted; it has no self-service product and must never
    // be reachable from a client-supplied plan value.
    if (!isCheckoutPlan(dto.plan)) {
      throw new BadRequestException('This plan is not available for self-service checkout.');
    }
    // Refuse to start a second subscription while one is live. Dodo would happily
    // create it, the customer would be billed twice, and the Subscription row can
    // hold only one subscription id — the other keeps billing with nothing here
    // able to resolve or cancel it.
    const existing = await this.prisma.subscription.findUnique({
      where: { organizationId },
      select: { dodoSubscriptionId: true, status: true },
    });
    if (existing?.dodoSubscriptionId && hasLiveSubscription(existing.status)) {
      throw new BadRequestException(
        'This organization already has a subscription. Change or cancel it from the billing portal instead.',
      );
    }
    const customerId = await this.getOrCreateCustomer(organizationId);
    const productId = this.getProductIdForPlan(dto.plan);
    const integrationIdentifier = this.newIntegrationIdentifier();
    // A Checkout Session, not `subscriptions.create({ payment_link: true })`:
    // Dodo deprecated the bare payment call, and the hosted session is what
    // collects the billing address and tax id this process does not hold. As a
    // Merchant of Record Dodo owns tax calculation, so there is no
    // `automatic_tax` switch to keep off.
    //
    // `dto.idempotencyKey` is deliberately not forwarded. Dodo's API defines no
    // idempotency header — the SDK's `idempotencyHeader` is never set, so a
    // request-options `idempotencyKey` would be accepted by the types and sent
    // nowhere, which is worse than not sending it. Double-charging is prevented
    // instead by the live-subscription refusal above and by the webhook keying
    // every grant on the payment or cycle it belongs to.
    const session = await this.callDodo('checkoutSessions.create', () =>
      dodo.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { customer_id: customerId },
        return_url: this.buildAppUrl(dto.successPath),
        cancel_url: this.buildAppUrl(dto.cancelPath),
        // Read back by the webhook to resolve the paying organization, and the only
        // record of which catalog version this price was quoted under.
        metadata: {
          organizationId,
          plan: dto.plan,
          catalogVersion: BILLING_CATALOG_VERSION,
          integration_identifier: integrationIdentifier,
        },
      }),
    );
    if (!session.checkout_url) {
      throw new InternalServerErrorException('Dodo Payments returned no checkout URL.');
    }
    await this.logBillingAudit(organizationId, actorUserId, 'billing.checkout_started', {
      plan: dto.plan,
      productId,
      dodoCustomerId: customerId,
      integrationIdentifier,
    });
    return { url: session.checkout_url };
  }

  /**
   * Prepaid 100-minute pack. Extra usage is prepaid only, so this is a one-time
   * cart against a server-owned product; the client never supplies a product ID
   * or an amount. Only an organization with paid access may buy one, because
   * packs are consumed after included minutes.
   */
  async createTopUpCheckoutSession(
    organizationId: string,
    dto: CreateTopUpCheckoutDto,
    actorUserId: string,
  ): Promise<{ url: string }> {
    this.assertDodoConfigured(DODO_TOPUP_REQUIRED_ENV);
    const dodo = this.dodo;
    if (!dodo) throw new InternalServerErrorException('Dodo Payments is not configured.');
    const productId = env.DODO_MINUTE_PACK_PRODUCT_ID;
    if (!productId) {
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
    const session = await this.callDodo('checkoutSessions.create', () =>
      dodo.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { customer_id: customerId },
        // Cards only, deliberately, and for the reason the Stripe session pinned
        // `payment_method_types: ['card']`: the pack is granted from
        // `payment.succeeded` and nothing grants it later, so a method that settles
        // days after checkout would be paid for and never credited. A subscription
        // is safe without this because its credit comes from the cycle event
        // whenever the money actually clears.
        allowed_payment_method_types: ['credit', 'debit'],
        return_url: this.buildAppUrl(dto.successPath),
        cancel_url: this.buildAppUrl(dto.cancelPath),
        metadata: {
          organizationId,
          purchaseType: 'minute_pack',
          catalogVersion: BILLING_CATALOG_VERSION,
          integration_identifier: integrationIdentifier,
        },
      }),
    );
    if (!session.checkout_url) {
      throw new InternalServerErrorException('Dodo Payments returned no checkout URL.');
    }
    await this.logBillingAudit(organizationId, actorUserId, 'billing.topup_checkout_started', {
      productId,
      dodoCustomerId: customerId,
      catalogVersion: BILLING_CATALOG_VERSION,
      integrationIdentifier,
    });
    return { url: session.checkout_url };
  }

  /**
   * Correlates one Checkout attempt across our audit log and the Dodo dashboard
   * without exposing anything about the organization.
   */
  private newIntegrationIdentifier(): string {
    return `vf_${randomBytes(12).toString('hex')}`;
  }

  async createPortalSession(
    organizationId: string,
    dto: CreatePortalSessionDto,
    actorUserId: string,
  ): Promise<{ url: string }> {
    this.assertDodoConfigured(DODO_PORTAL_REQUIRED_ENV);
    const dodo = this.dodo;
    if (!dodo) throw new InternalServerErrorException('Dodo Payments is not configured.');
    const customerId = await this.getOrCreateCustomer(organizationId);
    // No configuration object to pass: Dodo's portal has one feature set, owned
    // by the merchant account, so the Stripe-era STRIPE_PORTAL_CONFIGURATION_ID
    // has no equivalent and is gone from the environment.
    const session = await this.callDodo('customers.customerPortal.create', () =>
      dodo.customers.customerPortal.create(customerId, {
        return_url: this.buildAppUrl(dto.returnPath),
      }),
    );
    if (!session.link) {
      throw new InternalServerErrorException('Dodo Payments returned no portal URL.');
    }
    await this.logBillingAudit(organizationId, actorUserId, 'billing.portal_opened', {
      dodoCustomerId: customerId,
    });
    return { url: session.link };
  }

  private getProductIdForPlan(plan: CheckoutPlan): string {
    const productIds: Record<CheckoutPlan, string | undefined> = {
      starter: env.DODO_STARTER_PRODUCT_ID,
      growth: env.DODO_GROWTH_PRODUCT_ID,
    };
    const productId = productIds[plan];
    if (!productId) {
      throw new InternalServerErrorException(`Dodo product ID is not configured for ${plan}.`);
    }
    return productId;
  }

  /**
   * Each entry point fails closed on its own configuration, and only its own: a
   * deployment without DODO_MINUTE_PACK_PRODUCT_ID cannot sell packs but must
   * still take subscription payments and open the portal, because one unset
   * product ID used to 503 all three. Still fails closed — a partially configured
   * deployment never sends a customer to a checkout it cannot then settle with,
   * and never invents a free allowance. The lists live in config/env so these
   * gates, the boot refinement and the deploy gate cannot drift apart.
   */
  private assertDodoConfigured(required: readonly DodoEnvName[]): void {
    if (!this.isDodoConfigured(required)) {
      throw new BillingUnavailableError(CHECKOUT_UNCONFIGURED_MESSAGE);
    }
  }

  /**
   * Runs one Dodo SDK call and turns the provider's own 4xx into this module's
   * "billing temporarily unavailable".
   *
   * A Dodo 4xx is a statement about the merchant account or the catalog —
   * `MERCHANT_NOT_LIVE` (observed during the live cutover, when it surfaced as an
   * unhandled 500), an archived product, an invalid discount — not a fault in this
   * process. Reported as a 500 it pages the wrong team, tells the customer
   * nothing, and looks identical to a crash mid-payment. It is the same outcome as
   * an unconfigured deployment, so it reuses {@link BillingUnavailableError} and
   * the same message, with the Dodo code appended so support can act on it.
   *
   * 5xx and connection failures are deliberately left to propagate unchanged:
   * those are transient, the SDK has already retried them, and a 503 would tell
   * the customer to come back later for something that may succeed on the next
   * click. `APIConnectionError` carries an undefined status, which this skips.
   */
  private async callDodo<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      const status = err instanceof APIError ? err.status : undefined;
      if (status === undefined || status < 400 || status >= 500) throw err;
      const code = dodoErrorCode(err instanceof APIError ? err.error : undefined);
      this.logger.error(`Dodo ${operation} failed: HTTP ${status} ${code}`);
      throw new BillingUnavailableError(`${CHECKOUT_UNCONFIGURED_MESSAGE} (Dodo: ${code})`);
    }
  }

  private isDodoConfigured(required: readonly DodoEnvName[]): boolean {
    return Boolean(this.dodo) && missingDodoEnv(required, env).length === 0;
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
      dodoCustomerId: sub.dodoCustomerId,
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

    // This used to read `usage_records`, a reporting table that only the legacy
    // call-end paths in CallsService write. LiveKit calls end through the
    // telephony webhook and the runtime finalizer, which write `call_usages` —
    // the ledger the customer is actually charged from — so the panel showed
    // 0 calls and 0 minutes while credit was being debited (prod, 2026-09-02:
    // five completed calls, 600 s debited, no usage_records row at all). Read
    // the ledger the charge comes from.
    const [rows, agents, tools, sub] = await Promise.all([
      this.prisma.callUsage.findMany({
        where: { workspaceId, createdAt: { gte: start, lte: end } },
        select: { connectedAt: true, billableSeconds: true },
      }),
      this.prisma.agent.count({ where: { workspaceId } }),
      this.prisma.integrationTool.count({ where: { workspaceId } }),
      this.getSubscription(ws.organizationId),
    ]);
    // A call counts once it connected; billable seconds are already rounded up
    // to the minute per call by the ledger, so the sum divides exactly.
    const calls = rows.filter((row) => row.connectedAt !== null).length;
    const minutes = Math.ceil(rows.reduce((sum, row) => sum + row.billableSeconds, 0) / 60);

    const plan = (sub?.plan ?? 'free') as keyof typeof SHARED_PLAN_LIMITS;
    const limits = SHARED_PLAN_LIMITS[plan];
    const usage = { calls, minutes, tools, agents };

    return {
      workspaceId,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      metrics: usage,
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

  /**
   * Billing history for a customer.
   *
   * Dodo has no listable invoice object — `invoices` only serves a payment's PDF
   * — so the list is built from payments, each of which carries the invoice id and
   * PDF URL that its invoice would have. `InvoiceDto` is unchanged: `amountPaid`
   * is the charged total only once the payment actually succeeded, and the period
   * columns fall back to the payment date the same way the Stripe mapping did for
   * an invoice without a period.
   */
  async getInvoices(dodoCustomerId: string): Promise<{ items: InvoiceDto[] }> {
    if (!this.dodo) return { items: [] };
    const payments = await this.dodo.payments.list({
      customer_id: dodoCustomerId,
      page_size: 12,
    });
    return {
      items: payments.items.map((payment) => {
        const created = Math.floor(new Date(payment.created_at).getTime() / 1000);
        return {
          id: payment.payment_id,
          number: payment.invoice_id ?? null,
          status: payment.status ?? null,
          amountDue: payment.total_amount,
          amountPaid: payment.status === 'succeeded' ? payment.total_amount : 0,
          currency: payment.currency,
          created,
          periodStart: created,
          periodEnd: created,
          invoicePdf: payment.invoice_url ?? null,
          hostedInvoiceUrl: payment.invoice_url ?? null,
        };
      }),
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
