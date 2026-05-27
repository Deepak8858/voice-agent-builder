import {
  BadRequestException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import type {
  CheckoutPlan,
  CreateCheckoutSessionDto,
  CreatePortalSessionDto,
  FeatureGate,
  InvoiceDto,
  PlanType,
  SubscriptionDto,
  SubscriptionStatus,
  WorkspaceUsageDto,
} from '@voiceforge/shared';
import { PLAN_LIMITS as SHARED_PLAN_LIMITS } from '@voiceforge/shared';
import type { ApiErrorCode } from '@voiceforge/shared';
import { AppError } from '../common/errors';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

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
      create(params: Record<string, unknown>): Promise<StripeSession>;
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

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly stripe: StripeClient | null;

  constructor(private readonly prisma: PrismaService) {
    this.stripe = env.STRIPE_SECRET_KEY
      ? (new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' }) as unknown as StripeClient)
      : null;
    if (!this.stripe) {
      this.logger.warn('STRIPE_SECRET_KEY is not set. Stripe operations will be no-ops.');
    }
  }

  // -------------------------------------------------------------------------
  // Customer management
  // -------------------------------------------------------------------------

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
  ): Promise<{ url: string }> {
    if (!this.stripe) throw new InternalServerErrorException('Stripe is not configured.');
    const customerId = await this.getOrCreateCustomer(organizationId);
    const priceId = this.getPriceIdForPlan(dto.plan);
    const successUrl = this.withCheckoutSessionId(this.buildAppUrl(dto.successPath));
    const cancelUrl = this.buildAppUrl(dto.cancelPath);
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      metadata: { organizationId, plan: dto.plan },
      subscription_data: {
        metadata: { organizationId, plan: dto.plan },
      },
    });
    if (!session.url) throw new InternalServerErrorException('Stripe returned no URL.');
    await this.logBillingAudit(organizationId, 'billing.checkout_started', {
      plan: dto.plan,
      priceId,
      stripeCustomerId: customerId,
    });
    return { url: session.url };
  }

  async createPortalSession(
    organizationId: string,
    dto: CreatePortalSessionDto,
  ): Promise<{ url: string }> {
    if (!this.stripe) throw new InternalServerErrorException('Stripe is not configured.');
    const customerId = await this.getOrCreateCustomer(organizationId);
    const returnUrl = this.buildAppUrl(dto.returnPath);
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    if (!session.url) throw new InternalServerErrorException('Stripe returned no portal URL.');
    await this.logBillingAudit(organizationId, 'billing.portal_opened', {
      stripeCustomerId: customerId,
    });
    return { url: session.url };
  }

  private getPriceIdForPlan(plan: CheckoutPlan): string {
    const priceIds: Record<CheckoutPlan, string | undefined> = {
      starter: env.STRIPE_STARTER_PRICE_ID,
      growth: env.STRIPE_GROWTH_PRICE_ID,
      enterprise: env.STRIPE_ENTERPRISE_PRICE_ID,
    };
    const priceId = priceIds[plan];
    if (!priceId) {
      throw new InternalServerErrorException(`Stripe price ID is not configured for ${plan}.`);
    }
    return priceId;
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

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  async getSubscription(organizationId: string): Promise<SubscriptionDto | null> {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });
    if (!sub) return null;
    return {
      id: sub.id,
      plan: sub.plan as PlanType,
      status: sub.status as SubscriptionStatus,
      currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      trialEnd: sub.trialEnd?.toISOString() ?? null,
      stripeCustomerId: sub.stripeCustomerId,
    };
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
        periodStart: { gte: start },
        periodEnd: { lte: end },
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
        calls: limits.outboundCalls,
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

  async checkFeatureGate(
    organizationId: string,
    gate: FeatureGate,
  ): Promise<boolean> {
    const sub = await this.getSubscription(organizationId);
    let plan = (sub?.plan ?? 'free') as keyof typeof SHARED_PLAN_LIMITS;

    // Treat expired trials as free plan
    if (sub?.status === 'trialing' && sub?.trialEnd && new Date(sub.trialEnd) < new Date()) {
      plan = 'free';
    }

    const limits = SHARED_PLAN_LIMITS[plan];

    switch (gate) {
      case 'outbound':
        return limits.outboundCalls > 0 || limits.outboundCalls === -1;
      case 'ai_insights':
        return plan !== 'free';
      case 'compliance_blocks':
        return Boolean(limits.complianceBlocks);
      case 'white_label':
        return plan === 'growth' || plan === 'enterprise';
      case 'api_access':
        return plan !== 'free';
      case 'bulk_import':
        return plan !== 'free';
      case 'analytics':
        return plan !== 'free';
      case 'multiple_workspaces':
        return limits.workspaces !== 1;
      default:
        return false;
    }
  }

  async canPublishAgent(organizationId: string, currentAgentCount: number): Promise<boolean> {
    const sub = await this.getSubscription(organizationId);
    const plan = (sub?.plan ?? 'free') as keyof typeof SHARED_PLAN_LIMITS;
    const limit = SHARED_PLAN_LIMITS[plan].agents;
    return limit === -1 || currentAgentCount < limit;
  }

  async canOutboundCall(organizationId: string, currentCallCount: number): Promise<boolean> {
    const sub = await this.getSubscription(organizationId);
    const plan = (sub?.plan ?? 'free') as keyof typeof SHARED_PLAN_LIMITS;
    const limit = SHARED_PLAN_LIMITS[plan].outboundCalls;
    return limit === -1 || currentCallCount < limit;
  }

  async canStartOutboundCall(workspaceId: string): Promise<{ allowed: boolean; remaining: number; limit: number }> {
    const usage = await this.getWorkspaceUsage(workspaceId);
    const limit = usage.limits.calls ?? 0;
    const used = usage.metrics.calls ?? 0;
    const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
    return { allowed: remaining !== 0, remaining, limit };
  }

  async enforceAgentLimit(organizationId: string): Promise<void> {
    const count = await this.prisma.agent.count({
      where: { workspace: { organizationId }, status: 'published' },
    });
    const allowed = await this.canPublishAgent(organizationId, count);
    if (!allowed) {
      const sub = await this.getSubscription(organizationId);
      const plan = sub?.plan ?? 'free';
      throw new ForbiddenPlanError(
        `Your ${plan} plan allows a limited number of published agents. Please upgrade to publish more.`,
      );
    }
  }

  async checkAgentCreationWarning(organizationId: string): Promise<{ warning: string | null; current: number; limit: number }> {
    const sub = await this.getSubscription(organizationId);
    const plan = (sub?.plan ?? 'free') as keyof typeof SHARED_PLAN_LIMITS;
    const limit = SHARED_PLAN_LIMITS[plan].agents;
    if (limit === -1) return { warning: null, current: 0, limit: -1 };
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
  constructor(message: string) {
    super('PLAN_LIMIT_EXCEEDED' as ApiErrorCode, message, HttpStatus.FORBIDDEN);
  }
}
