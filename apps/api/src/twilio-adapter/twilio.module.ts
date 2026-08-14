import { Global, Module } from '@nestjs/common';
import { TwilioVoiceAdapter } from './twilio.adapter';
import { VoicePipelineService } from './voice-pipeline.service';
import { CallSessionManager } from './call-session-manager';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { TwilioSignatureVerifier } from './twilio-signature.verifier';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  // The legacy inbound webhook opens a billable media stream, so it needs the
  // same admission gate as every other dispatch path.
  imports: [PrismaModule, BillingModule],
  controllers: [TwilioWebhookController],
  providers: [
    CallSessionManager,
    VoicePipelineService,
    TwilioVoiceAdapter,
    TwilioSignatureVerifier,
  ],
  exports: [TwilioVoiceAdapter, VoicePipelineService, CallSessionManager],
})
export class TwilioModule {}
