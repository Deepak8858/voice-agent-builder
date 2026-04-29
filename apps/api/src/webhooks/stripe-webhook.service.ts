import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {
    this.stripe = env.STRIPE_SECRET_KEY
      ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
      : null;
  }

  async handleWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<{ handled: boolean; message: string }> {
    if (!this.stripe || !env.STRIPE_WEBHOOK_SECRET) {
      this.logger.warn('Stripe not configured; skipping webhook.');
      return { handled: false, message: 'Stripe not configured' };
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err}`);
      return { handled: false, message: 'Invalid signature' };
    }

    // Idempotency: skip already-processed events
    const existing = await this.prisma.stripeEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (existing?.processedAt) {
      return { handled: true, message: `Event ${event.id} already processed` };
    }

    try {
      await this.dispatch(event);
      await this.markProcessed(event.id);
      return { handled: true, message: `Event ${event.id} processed` };
    } catch (err) {
      await this.markError(event.id, String(err));
      return { handled: false, message: String(err) };
    }
  }

  private async markProcessed(stripeEventId: string): Promise<void> {
    await this.prisma.stripeEvent.upsert({
      where: { stripeEventId },
      create: {
        stripeEventId,
        type: 'unknown',
        created: new Date(),
        data: {},
        livemode: false,
        pendingWebhooks: 0,
        processedAt: new Date(),
      },
      update: { processedAt: new Date(), errorMessage: null },
    });
  }

  private async markError(stripeEventId: string, errorMessage: string): Promise<void> {
    await this.prisma.stripeEvent.upsert({
      where: { stripeEventId },
      create: {
        stripeEventId,
        type: 'unknown',
        created: new Date(),
        data: {},
        livemode: false,
        pendingWebhooks: 0,
        errorMessage,
      },
      update: { errorMessage },
    });
  }

  private async dispatch(event: Stripe.Event): Promise<void> {
    const data = event.data.object as unknown as Record<string, unknown>;
    const orgId = (data['metadata'] as Record<string, string> | undefined)?.organizationId;

    switch (event.type) {
      case 'checkout.session.completed': {
        const customerId = data['customer'] as string;
        if (orgId && customerId) {
          await this.handleCheckoutCompleted(orgId, customerId, data);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const subId = data['id'] as string;
        const customerId = data['customer'] as string;
        if (subId && customerId) {
          await this.handleSubscriptionUpdated(subId, customerId, data);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subId = data['id'] as string;
        if (subId) {
          await this.handleSubscriptionDeleted(subId, data);
        }
        break;
      }
      case 'invoice.paid': {
        const customerId = data['customer'] as string;
        if (customerId) {
          await this.handleInvoicePaid(customerId, data);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const customerId = data['customer'] as string;
        if (customerId) {
          await this.handleInvoicePaymentFailed(customerId, data);
        }
        break;
      }
      default:
        this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  private async handleCheckoutCompleted(
    orgId: string,
    customerId: string,
    _data: Record<string, unknown>,
  ): Promise<void> {
    this.logger.log(`Checkout completed for org ${orgId}, customer ${customerId}`);
    // Subscription updated will handle the plan change
  }

  private async handleSubscriptionUpdated(
    _stripeSubId: string,
    customerId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const status = data['status'] as string;
    const plan = this.inferPlan(data);
    const periodStart = new Date((data['current_period_start'] as number) * 1000);
    const periodEnd = new Date((data['current_period_end'] as number) * 1000);
    const cancelAtPeriodEnd = data['cancel_at_period_end'] as boolean;
    const trialEnd = data['trial_end']
      ? new Date((data['trial_end'] as number) * 1000)
      : null;

    await this.prisma.subscription.updateMany({
      where: { stripeCustomerId: customerId },
      data: {
        stripeSubscriptionId: data['id'] as string,
        status: status ?? 'active',
        plan,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: cancelAtPeriodEnd ?? false,
        trialEnd,
      },
    });
  }

  private async handleSubscriptionDeleted(
    stripeSubId: string,
    _data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { stripeSubscriptionId: stripeSubId },
      data: { status: 'canceled' },
    });
  }

  private async handleInvoicePaid(
    customerId: string,
    _data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { stripeCustomerId: customerId },
      data: { status: 'active' },
    });
  }

  private async handleInvoicePaymentFailed(
    customerId: string,
    _data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { stripeCustomerId: customerId },
      data: { status: 'past_due' },
    });
  }

  private inferPlan(data: Record<string, unknown>): string {
    const priceId = (data['items'] as { data: Array<{ price?: { id?: string } }> } | undefined)
      ?.data?.[0]?.price?.id;

    if (priceId === env.STRIPE_STARTER_PRICE_ID) return 'starter';
    if (priceId === env.STRIPE_GROWTH_PRICE_ID) return 'growth';
    if (priceId === env.STRIPE_ENTERPRISE_PRICE_ID) return 'enterprise';
    return 'free';
  }
}