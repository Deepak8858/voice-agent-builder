import { Global, Logger, Module } from '@nestjs/common';
import { env } from '../config/env';
import { TwilioVoiceAdapter } from '../twilio-adapter/twilio.adapter';
import { MockVoiceAdapter } from './adapters/mock.adapter';
import { OpenAIRealtimeVoiceAdapter } from './adapters/openai-realtime.adapter';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LiveKitKnowledgeController } from './livekit-knowledge.controller';
import { PipelineRouterService } from './pipeline-router.service';
import { VoiceProviderRegistry } from './voice-provider.registry';

export const VOICE_PROVIDER_TOKEN = Symbol.for('VOICE_PROVIDER_TOKEN');

function resolveVoiceProvider(
  twilio: TwilioVoiceAdapter,
  openaiRealtime: OpenAIRealtimeVoiceAdapter,
  mock: MockVoiceAdapter,
) {
  const logger = new Logger('VoiceModule');
  switch (env.VOICE_PROVIDER) {
    case 'mock':
      return mock;
    case 'twilio':
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        throw new Error('VOICE_PROVIDER=twilio but TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not set.');
      }
      return twilio;
    case 'openai-realtime':
      if (!env.OPENAI_API_KEY) {
        logger.warn('VOICE_PROVIDER=openai-realtime but OPENAI_API_KEY is not set. Using mock Realtime sessions.');
      }
      return openaiRealtime;
    default:
      if (env.NODE_ENV === 'production') {
        throw new Error(
          'VOICE_PROVIDER must be set in production. Choose `twilio` or `openai-realtime` and provide the matching credentials.',
        );
      }
      logger.warn(
        `No VOICE_PROVIDER configured (NODE_ENV=${env.NODE_ENV}). Using the development mock provider.`,
      );
      return mock;
  }
}

export const resolveVoiceProviderForTest = resolveVoiceProvider;

@Global()
@Module({
  imports: [KnowledgeModule],
  controllers: [LiveKitKnowledgeController],
  providers: [
    TwilioVoiceAdapter,
    OpenAIRealtimeVoiceAdapter,
    MockVoiceAdapter,
    VoiceProviderRegistry,
    PipelineRouterService,
    {
      provide: VOICE_PROVIDER_TOKEN,
      inject: [TwilioVoiceAdapter, OpenAIRealtimeVoiceAdapter, MockVoiceAdapter],
      useFactory: resolveVoiceProvider,
    },
  ],
  exports: [
    VOICE_PROVIDER_TOKEN,
    VoiceProviderRegistry,
    PipelineRouterService,
    TwilioVoiceAdapter,
    OpenAIRealtimeVoiceAdapter,
    MockVoiceAdapter,
  ],
})
export class VoiceModule {}
