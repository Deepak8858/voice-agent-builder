import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { AlertsService } from './alerts.service';

@Module({
  controllers: [BillingController],
  providers: [BillingService, AlertsService],
  exports: [BillingService, AlertsService],
})
export class BillingModule {}