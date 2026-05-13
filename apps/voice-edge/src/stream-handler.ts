// ws package's WebSocket — used for Deepgram WebSocket connection
import { WebSocket as WsWebSocket } from 'ws';

import type { Env, VoiceSession, DeepgramTranscript } from './types.js';
import { ulawToPcm16 } from './audio-utils.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { getSession, setSession } from './session-store.js';

export async function handleStream(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  socket: any,
  sessionId: string,
  env: Env,
): Promise<void> {
  const log = {
    info: (msg: string, data?: Record<string, unknown>) =>
      console.info(`[${sessionId}] ${msg}`, data ?? {}),
    error: (msg: string, err?: unknown) =>
      console.error(`[${sessionId}] ${msg}`, err),
  };

  // Load session from Redis
  let session: VoiceSession;
  try {
    const raw = await getSession(sessionId);
    if (!raw) {
      socket.send(JSON.stringify({ error: 'Session not found' }));
      socket.close();
      return;
    }
    session = JSON.parse(raw) as VoiceSession;
  } catch (err) {
    log.error('Failed to load session', err);
    socket.send(JSON.stringify({ error: 'Session load failed' }));
    socket.close();
    return;
  }

  const deepgram = new DeepgramClient(env.DEEPGRAM_API_KEY);
  const anthropic = new AnthropicClient(env.ANTHROPIC_API_KEY);
  const cartesia = new CartesiaClient(env.CARTESIA_API_KEY);

  let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> =
    session.history ?? [];

  let pendingTranscript = '';
  let ttsQueue = '';
  let ttsBusy = false;

  // Send TTS audio directly to Twilio
  const sendToTts = async (text: string) => {
    if (!text.trim()) return;
    ttsBusy = true;
    try {
      const stream = await cartesia.speechStream({
        text,
        voiceId: session.spec.voice?.voice_id ?? 'aemma-angry-hope',
        outputFormat: { container: 'raw', encoding: 'mulaw', sampleRate: 8000 },
      });
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value instanceof Uint8Array) {
          socket.send(JSON.stringify({
            event: 'media',
            streamSid: sessionId,
            media: {
              track: 'outbound',
              chunk: String(Date.now()),
              timestamp: '0',
              payload: Buffer.from(value).toString('base64'),
            },
          }));
        }
      }
    } catch (err) {
      log.error('TTS stream error', err);
    } finally {
      ttsBusy = false;
    }
  };

  // Flush accumulated text to TTS
  const flushTts = async () => {
    if (ttsQueue.trim()) {
      const toSend = ttsQueue;
      ttsQueue = '';
      await sendToTts(toSend);
    }
  };

  // Deepgram streaming transcription
  const dg = deepgram.transcribeStream({
    model: 'nova-3',
    sampleRate: 8000,
    channels: 1,
    encoding: 'mulaw',
  });

  dg.onTranscript(async (transcript: string, isFinal: boolean) => {
    if (isFinal) {
      const full = pendingTranscript + transcript;
      pendingTranscript = '';
      await handleTranscript(full);
    } else {
      pendingTranscript += transcript;
      // Interrupt: user talking → cancel pending TTS
      if (transcript.trim().length > 2) {
        ttsQueue = '';
      }
    }
  });

  // LLM orchestrator — takes user transcript, streams TTS response
  const handleTranscript = async (transcript: string) => {
    log.info('User said', { text: transcript });
    conversationHistory.push({ role: 'user', content: transcript });

    try {
      const response = await anthropic.stream({
        model: 'claude-haiku-4-5',
        maxTokens: 512,
        system: buildSystemPrompt(session.spec),
        messages: conversationHistory,
      });

      let fullResponse = '';
      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta?.text) {
          fullResponse += event.delta.text;
          ttsQueue += event.delta.text;
          if (ttsQueue.split(' ').length >= 3) {
            await flushTts();
          }
        }
      }
      if (ttsQueue) await flushTts();

      conversationHistory.push({ role: 'assistant', content: fullResponse });
      session.history = conversationHistory;
      await setSession(sessionId, JSON.stringify(session), 3600);
      log.info('Response complete', { chars: fullResponse.length });
    } catch (err) {
      log.error('LLM error', err);
      await sendToTts('I apologize, I encountered an issue. Please try again.');
    }
  };

  // Process audio from Twilio Media Streams
  socket.on('message', async (data: unknown) => {
    try {
      const raw = data instanceof Buffer ? data.toString() : String(data);
      const msg = JSON.parse(raw) as { event: string; media?: { payload: string } };
      if (msg.event === 'media' && msg.media?.payload) {
        const mulaw = Buffer.from(msg.media.payload, 'base64');
        const pcm = ulawToPcm16(mulaw);
        dg.send(pcm);
      } else if (msg.event === 'stop') {
        log.info('Call ended');
        await flushTts();
        socket.send(JSON.stringify({ event: 'stop', streamSid: sessionId }));
        socket.close();
      }
    } catch (err) {
      log.error('Message parse error', err);
    }
  });

  socket.on('close', () => {
    log.info('WebSocket closed');
    dg.close();
  });

  socket.on('error', (err: unknown) => {
    log.error('Socket error', err);
    dg.close();
  });

  // Send greeting after connection setup
  setTimeout(async () => {
    const greeting = session.spec.conversation_rules?.first_message ??
      `Hello, this is the AI assistant at ${session.spec.identity?.business_name ?? 'our office'}. How can I help you?`;

    conversationHistory.push({ role: 'assistant', content: greeting });
    await sendToTts(greeting);
    session.history = conversationHistory;
    await setSession(sessionId, JSON.stringify(session), 3600);
  }, 200);
}

// ---------------------------------------------------------------------------
// HTTP clients (minimal, no SDK bundle)
// ---------------------------------------------------------------------------

interface TranscriptCallback {
  (text: string, isFinal: boolean): void;
}

class DeepgramClient {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private pending: Buffer[] = [];
  private onTranscriptCb: TranscriptCallback = () => {};
  private encoder: any = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  transcribeStream(opts: {
    model: string;
    sampleRate: number;
    channels: number;
    encoding: string;
  }) {
    const self = this;
    this.encoder = new TextEncoder();

    const connect = () => {
      const url = `wss://api.deepgram.com/v1/listen?${new URLSearchParams({
        model: opts.model,
        encoding: opts.encoding,
        sample_rate: String(opts.sampleRate),
        channels: String(opts.channels),
        punctuate: 'true',
        interim_results: 'true',
        smart_format: 'true',
        token: self.apiKey,
      })}`;

      this.ws = new globalThis.WebSocket(url) as unknown as WebSocket;

      (this.ws as unknown as EventTarget).addEventListener('message', (event: Event) => {
        const msgEvent = event as MessageEvent;
        const data = JSON.parse(String(msgEvent.data)) as DeepgramTranscript;
        const text = data.channel?.alternatives?.[0]?.transcript ?? '';
        if (text) {
          self.onTranscriptCb(text, data.is_final ?? false);
        }
      });

      (this.ws as unknown as EventTarget).addEventListener('error', (err: Event) => {
        console.error('Deepgram WS error', err);
      });
    };

    connect();

    return {
      send: (pcm: Buffer) => {
        if (self.ws?.readyState === WebSocket.OPEN && self.encoder) {
          self.ws.send(self.encoder.encode(pcm));
        }
      },
      close: () => { self.ws?.close(); },
      onTranscript: (cb: TranscriptCallback) => { self.onTranscriptCb = cb; },
    };
  }
}

class AnthropicClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async *stream(opts: {
    model: string;
    maxTokens: number;
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): AsyncGenerator<{ type: string; delta?: { text: string } }> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        stream: true,
        system: opts.system,
        messages: opts.messages,
      }),
    });

    if (!res.body) throw new Error('No response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;

          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              yield { type: 'content_block_delta', delta: { text: event.delta.text } };
            }
          } catch {
            // Skip malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

class CartesiaClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  speechStream(opts: {
    text: string;
    voiceId: string;
    outputFormat: { container: string; encoding: string; sampleRate: number };
  }): Promise<ReadableStream<Uint8Array>> {
    return fetch('https://api.cartesia.ai/tts/stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonic-2',
        transcript: opts.text,
        voice: { mode: 'id', id: opts.voiceId },
        output_format: opts.outputFormat,
      }),
    }).then(async (r) => {
      if (!r.body) throw new Error('No response body');
      return r.body;
    }).then((body) => {
      // Wrap to return Uint8Array chunks
      const reader = body.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value instanceof Uint8Array ? value : new Uint8Array(value ?? new ArrayBuffer(0)));
        },
      });
    });
  }
}