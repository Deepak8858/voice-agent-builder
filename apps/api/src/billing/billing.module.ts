import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { CallConcurrencyService } from './call-concurrency.service';
import { CreditLedgerService } from './credit-ledger.service';
import { EntitlementService } from './entitlement.service';
import { ProviderCostService } from './provider-cost.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    CallConcurrencyService,
    CreditLedgerService,
    EntitlementService,
    ProviderCostService,
    ReconciliationService,
  ],
  exports: [
    BillingService,
    CallConcurrencyService,
    CreditLedgerService,
    EntitlementService,
    ProviderCostService,
    ReconciliationService,
  ],
})
export class BillingModule {}
