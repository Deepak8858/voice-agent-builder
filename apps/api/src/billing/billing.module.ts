import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { CreditLedgerService } from './credit-ledger.service';
import { CallConcurrencyService } from './call-concurrency.service';

@Module({
  controllers: [BillingController],
  providers: [BillingService, CreditLedgerService, CallConcurrencyService],
  exports: [BillingService, CreditLedgerService, CallConcurrencyService],
})
export class BillingModule {}
