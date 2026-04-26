import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import type { VoiceRuntimeProvider } from './voice.provider.interface';

function notConfigured(): never {
  throw new AppError(
    'VOICE_PROVIDER_ERROR',
    'Vapi adapter is not configured. Set VAPI_API_KEY and switch VOICE_PROVIDER=vapi.',
    501,
  );
}

@Injectable()
export class VapiVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'vapi';
  createAgent = notConfigured;
  updateAgent = notConfigured;
  createBrowserTestSession = notConfigured;
  startOutboundCall = notConfigured;
  transferCall = notConfigured;
  endCall = notConfigured;
  getTranscript = notConfigured;
  getRecording = notConfigured;
}
