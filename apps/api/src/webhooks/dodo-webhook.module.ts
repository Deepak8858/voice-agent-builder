import { Module } from '@nestjs/common';
import { DodoWebhookController } from './dodo-webhook.controller';
import { DodoWebhookService } from './dodo-webhook.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  // BillingModule for CreditLedgerService. QueueModule is gone: the Stripe
  // version injected QueueService and BillingService and used neither.
  imports: [BillingModule],
  controllers: [DodoWebhookController],
  providers: [DodoWebhookService],
})
export class DodoWebhookModule {}
