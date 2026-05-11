import { Global, Module } from '@nestjs/common';
import { TwilioVoiceAdapter } from './twilio.adapter';
import { VoicePipelineService } from './voice-pipeline.service';
import { CallSessionManager } from './call-session-manager';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [TwilioWebhookController],
  providers: [
    CallSessionManager,
    VoicePipelineService,
    TwilioVoiceAdapter,
  ],
  exports: [TwilioVoiceAdapter, VoicePipelineService, CallSessionManager],
})
export class TwilioModule {}
