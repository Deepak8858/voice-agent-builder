import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { CallSessionManager } from './call-session-manager';

@Injectable()
export class VoicePipelineService {
  private readonly logger = new Logger(VoicePipelineService.name);

  constructor(private readonly sessionManager: CallSessionManager) {}

  async startInboundStream(sessionId: string): Promise<string> {
    const session = this.sessionManager.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const wsUrl = `wss://api.deepgram.com/v1/listen?model=${env.DEEPGRAM_STT_MODEL ?? 'nova-3'}&punctuate=true&smart_format=true`;

    this.logger.log(`Starting Deepgram stream for session ${sessionId}`);
    this.sessionManager.updateStatus(sessionId, 'streaming');

    return wsUrl;
  }

  async transcribeChunk(sessionId: string, audioBuffer: Buffer): Promise<string> {
    const session = this.sessionManager.get(sessionId);
    if (!session) return '';
    return '';
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!env.DEEPGRAM_API_KEY) {
      this.logger.warn('DEEPGRAM_API_KEY not set, TTS returning empty buffer');
      return Buffer.alloc(0);
    }

    const res = await fetch('https://api.deepgram.com/v1/speak', {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model: 'aura-2-en-us',
        encoding: 'linear16',
        sample_rate: 24000,
      }),
    });

    if (!res.ok) {
      this.logger.error(`Deepgram TTS failed: ${res.status}`);
      return Buffer.alloc(0);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  async endStream(sessionId: string): Promise<void> {
    this.sessionManager.end(sessionId);
    this.logger.log(`Stream ended for session ${sessionId}`);
  }
}
