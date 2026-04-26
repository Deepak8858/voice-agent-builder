import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import type { VoiceRuntimeProvider } from './voice.provider.interface';

function notConfigured(): never {
  throw new AppError(
    'VOICE_PROVIDER_ERROR',
    'Retell adapter is not configured. Set RETELL_API_KEY and switch VOICE_PROVIDER=retell.',
    501,
  );
}

@Injectable()
export class RetellVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'retell';
  createAgent = notConfigured;
  updateAgent = notConfigured;
  createBrowserTestSession = notConfigured;
  startOutboundCall = notConfigured;
  transferCall = notConfigured;
  endCall = notConfigured;
  getTranscript = notConfigured;
  getRecording = notConfigured;
}
