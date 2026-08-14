import { Global, Module } from '@nestjs/common';
import { TwilioVoiceAdapter } from './twilio.adapter';
import { VoicePipelineService } from './voice-pipeline.service';
import { CallSessionManager } from './call-session-manager';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { TwilioSignatureVerifier } from './twilio-signature.verifier';
import { TwilioProviderAdapter } from '../telephony/providers/twilio.provider';
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
    // Signature verification is the only authentication these webhooks have, so
    // the adapter that performs it is a declared dependency rather than one the
    // verifier constructs, and can therefore be substituted in tests.
    TwilioProviderAdapter,
    TwilioSignatureVerifier,
  ],
  exports: [TwilioVoiceAdapter, VoicePipelineService, CallSessionManager],
})
export class TwilioModule {}
