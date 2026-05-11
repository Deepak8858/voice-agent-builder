import { Module } from '@nestjs/common';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { BillingModule } from '../billing/billing.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [BillingModule, QueueModule],
  controllers: [StripeWebhookController],
  providers: [StripeWebhookService],
})
export class StripeWebhookModule {}