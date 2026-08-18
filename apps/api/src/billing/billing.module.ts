import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { CallAdmissionService } from './call-admission.service';
import { CallConcurrencyService } from './call-concurrency.service';
import { CreditLedgerService } from './credit-ledger.service';
import { EntitlementService } from './entitlement.service';
import { ProviderCostService } from './provider-cost.service';
import { ReconciliationService } from './reconciliation.service';
import { RuntimeUsageController } from './runtime-usage.controller';
import { RuntimeUsageService } from './runtime-usage.service';

@Module({
  controllers: [BillingController, RuntimeUsageController],
  providers: [
    BillingService,
    CallAdmissionService,
    CallConcurrencyService,
    CreditLedgerService,
    EntitlementService,
    ProviderCostService,
    ReconciliationService,
    RuntimeUsageService,
  ],
  exports: [
    BillingService,
    CallAdmissionService,
    CallConcurrencyService,
    CreditLedgerService,
    EntitlementService,
    ProviderCostService,
    ReconciliationService,
    RuntimeUsageService,
  ],
})
export class BillingModule {}
