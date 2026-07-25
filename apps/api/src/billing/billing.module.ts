import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { CreditLedgerService } from './credit-ledger.service';

@Module({
  controllers: [BillingController],
  providers: [BillingService, CreditLedgerService],
  exports: [BillingService, CreditLedgerService],
})
export class BillingModule {}
