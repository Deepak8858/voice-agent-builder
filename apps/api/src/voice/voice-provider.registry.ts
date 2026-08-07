import { Injectable } from '@nestjs/common';
import type { PlanType } from '@voiceforge/shared';
import { TwilioVoiceAdapter } from '../twilio-adapter/twilio.adapter';
import { MockVoiceAdapter } from './adapters/mock.adapter';
import { OpenAIRealtimeVoiceAdapter } from './adapters/openai-realtime.adapter';
import { RetellVoiceAdapter } from './adapters/retell.adapter';
import { VapiVoiceAdapter } from './adapters/vapi.adapter';
import type { VoiceRuntimeProvider } from './adapters/voice.provider.interface';
import { env } from '../config/env';

export type VoiceProviderName = 'mock' | 'vapi' | 'twilio' | 'openai-realtime' | 'retell';

@Injectable()
export class VoiceProviderRegistry {
  constructor(
    private readonly vapi: VapiVoiceAdapter,
    private readonly twilio: TwilioVoiceAdapter,
    private readonly openaiRealtime: OpenAIRealtimeVoiceAdapter,
    private readonly retell: RetellVoiceAdapter,
    private readonly mock: MockVoiceAdapter,
  ) {}

  forPlan(_plan: PlanType): VoiceRuntimeProvider {
    return this.defaultProvider();
  }

  byName(name: string | null | undefined): VoiceRuntimeProvider {
    switch (name) {
      case 'mock':
        return this.mock;
      case 'vapi':
        return this.vapi;
      case 'openai-realtime':
        return this.openaiRealtime;
      case 'retell':
        return this.retell;
      case 'twilio':
        return this.twilio;
      default:
        return this.defaultProvider();
    }
  }

  defaultProvider(): VoiceRuntimeProvider {
    return this.byConfiguredName(env.VOICE_PROVIDER);
  }

  private byConfiguredName(name: VoiceProviderName | undefined): VoiceRuntimeProvider {
    switch (name) {
      case 'mock':
        return this.mock;
      case 'vapi':
        return this.vapi;
      case 'openai-realtime':
        return this.openaiRealtime;
      case 'retell':
        return this.retell;
      case 'twilio':
        return this.twilio;
      default:
        return this.mock;
    }
  }
}
