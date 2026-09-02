import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SecurityModule } from '../security/security.module';
import { TelephonyController } from './telephony.controller';
import { TelephonyInternalController } from './telephony-internal.controller';
import { TelephonyWebhookController } from './telephony-webhook.controller';
import { TelephonyService } from './telephony.service';
import { ProviderRegistry } from './providers/provider-registry';
import { TwilioProviderAdapter } from './providers/twilio.provider';

@Module({
  // VoiceModule is global, so PipelineRouterService resolves without importing it.
  imports: [PrismaModule, AuditModule, BillingModule, ComplianceModule, LiveKitModule, SecurityModule],
  controllers: [TelephonyController, TelephonyInternalController, TelephonyWebhookController],
  providers: [TelephonyService, ProviderRegistry, TwilioProviderAdapter],
  exports: [TelephonyService],
})
export class TelephonyModule {}
