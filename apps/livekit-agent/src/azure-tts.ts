import { AudioByteStream, shortuuid, tts, type APIConnectOptions } from '@livekit/agents';
import { speechsdk } from '@livekit/agents-plugin-azure';
import type { AudioFrame } from '@livekit/rtc-node';

/**
 * Azure Speech text-to-speech for the in-house ("standard") pipeline.
 *
 * `@livekit/agents-plugin-azure` ships streaming STT only — there is no
 * `azure.TTS` in the JS plugin line and no separate Azure TTS plugin is
 * published. This adapter closes that gap using the Speech SDK the STT plugin
 * already depends on (and re-exports as `speechsdk`), so no extra dependency is
 * introduced.
 *
 * Capabilities are declared as non-streaming. That is deliberate: the voice
 * framework then wraps this TTS in `tts.StreamAdapter` with a sentence
 * tokenizer, so LLM output is synthesized sentence-by-sentence as it streams
 * instead of waiting for the full response. Time-to-first-audio therefore
 * tracks the first sentence, which is what the low-latency posture needs.
 */

/** Azure `Raw24Khz16BitMonoPcm`: what every neural voice can emit without transcoding. */
const AZURE_TTS_SAMPLE_RATE = 24_000;
const AZURE_TTS_CHANNELS = 1;

export interface AzureSpeechTTSOptions {
  /** Azure Speech subscription key. Defaults to `AZURE_SPEECH_KEY`. */
  speechKey?: string;
  /** Azure Speech region (e.g. `eastus`). Defaults to `AZURE_SPEECH_REGION`. */
  speechRegion?: string;
  /** Neural voice name. Defaults to `AZURE_TTS_VOICE`, then a multilingual voice. */
  voice?: string;
  /** BCP-47 synthesis language. Optional; the voice name already implies one. */
  language?: string;
}

export const DEFAULT_AZURE_TTS_VOICE = 'en-US-AvaMultilingualNeural';

/**
 * Thrown when the worker is asked to synthesize without Azure Speech
 * credentials. Named so the failure is attributable in worker logs rather than
 * surfacing as an opaque SDK error mid-call.
 */
export class AzureSpeechConfigurationError extends Error {
  override readonly name = 'AzureSpeechConfigurationError';
}

export class AzureSpeechTTS extends tts.TTS {
  label = 'azure.SpeechTTS';

  readonly #voice: string;
  readonly #speechConfig: speechsdk.SpeechConfig;
  #synthesizer: speechsdk.SpeechSynthesizer | undefined;

  constructor(opts: AzureSpeechTTSOptions = {}) {
    super(AZURE_TTS_SAMPLE_RATE, AZURE_TTS_CHANNELS, { streaming: false });

    const speechKey = opts.speechKey ?? process.env.AZURE_SPEECH_KEY;
    const speechRegion = opts.speechRegion ?? process.env.AZURE_SPEECH_REGION;
    if (!speechKey || !speechRegion) {
      throw new AzureSpeechConfigurationError(
        'Azure Speech TTS requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION ' +
          '(or explicit speechKey/speechRegion options).',
      );
    }

    this.#voice =
      opts.voice?.trim() || process.env.AZURE_TTS_VOICE?.trim() || DEFAULT_AZURE_TTS_VOICE;

    const speechConfig = speechsdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechSynthesisVoiceName = this.#voice;
    // Raw PCM avoids a RIFF header that would be framed as audio samples.
    speechConfig.speechSynthesisOutputFormat =
      speechsdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
    if (opts.language) {
      speechConfig.speechSynthesisLanguage = opts.language;
    }
    this.#speechConfig = speechConfig;
  }

  override get model(): string {
    return this.#voice;
  }

  override get provider(): string {
    return 'azure';
  }

  get voice(): string {
    return this.#voice;
  }

  /**
   * One synthesizer is shared by every utterance so the websocket handshake is
   * paid once per call instead of once per sentence. `null` audio config keeps
   * the SDK from grabbing a default speaker device; each request supplies its
   * own push stream instead.
   */
  #resolveSynthesizer(): speechsdk.SpeechSynthesizer {
    if (!this.#synthesizer) {
      this.#synthesizer = new speechsdk.SpeechSynthesizer(this.#speechConfig, null);
    }
    return this.#synthesizer;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    const synthesizer = this.#resolveSynthesizer();
    return new AzureSpeechChunkedStream(
      this,
      text,
      synthesizer,
      () => this.#cancelSynthesis(synthesizer),
      connOptions,
      abortSignal,
    );
  }

  /** Closing is the Speech SDK's supported cancellation mechanism for a
   * SpeechSynthesizer. Drop the cached instance first so the next sentence
   * cannot reuse an object that is being closed after barge-in. */
  #cancelSynthesis(synthesizer: speechsdk.SpeechSynthesizer): void {
    if (this.#synthesizer === synthesizer) this.#synthesizer = undefined;
    synthesizer.close(
      () => undefined,
      () => undefined,
    );
  }

  stream(): tts.SynthesizeStream {
    // The framework wraps non-streaming TTS in tts.StreamAdapter, which only
    // ever calls synthesize(). Reaching here means that wrapping was bypassed.
    throw new Error(
      'AzureSpeechTTS is non-streaming; wrap it in tts.StreamAdapter to obtain a SynthesizeStream.',
    );
  }

  override async close(): Promise<void> {
    const synthesizer = this.#synthesizer;
    this.#synthesizer = undefined;
    if (synthesizer) {
      await new Promise<void>((resolve) => {
        synthesizer.close(
          () => resolve(),
          () => resolve(),
        );
      });
    }
    await super.close();
  }
}

export class AzureSpeechChunkedStream extends tts.ChunkedStream {
  label = 'azure.SpeechChunkedStream';

  readonly #synthesizer: speechsdk.SpeechSynthesizer;
  readonly #cancelSynthesis: () => void;

  constructor(
    parent: AzureSpeechTTS,
    text: string,
    synthesizer: speechsdk.SpeechSynthesizer,
    cancelSynthesis: () => void,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, parent, connOptions, abortSignal);
    this.#synthesizer = synthesizer;
    this.#cancelSynthesis = cancelSynthesis;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const byteStream = new AudioByteStream(AZURE_TTS_SAMPLE_RATE, AZURE_TTS_CHANNELS);

    // Frames are emitted as Azure pushes bytes so playback can start before the
    // utterance finishes synthesizing. `final` must land on the last frame, so
    // one frame is always held back until the next one (or completion) arrives.
    // Azure can invoke the sink after an abort, so `finished` prevents writes to
    // the queue after cleanup has closed it.
    let finished = false;
    let pendingFrame: AudioFrame | undefined;
    const flushPending = (final: boolean): void => {
      if (finished || !pendingFrame) return;
      this.queue.put({ requestId, segmentId: requestId, frame: pendingFrame, final });
      pendingFrame = undefined;
    };
    const enqueue = (frames: AudioFrame[]): void => {
      if (finished) return;
      for (const frame of frames) {
        flushPending(false);
        pendingFrame = frame;
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        if (this.abortSignal.aborted) {
          resolve();
          return;
        }
        // SpeechSynthesizer has no per-utterance stop API. Closing the active
        // instance is the supported cancellation path; the parent drops it so a
        // later sentence lazily creates a fresh connection.
        const onAbort = (): void => {
          finished = true;
          pendingFrame = undefined;
          this.#cancelSynthesis();
          resolve();
        };
        this.abortSignal.addEventListener('abort', onAbort, { once: true });

        // Must be the raw callback, not `PushAudioOutputStream.create(...)`:
        // the SDK only unwraps a `PushAudioOutputStreamCallback` and otherwise
        // treats the argument as a file path to write to.
        const sink = new (class extends speechsdk.PushAudioOutputStreamCallback {
          write(dataBuffer: ArrayBuffer): void {
            enqueue(byteStream.write(dataBuffer));
          }
          close(): void {
            // Completion is signalled by the synthesis callbacks below; the
            // stream close alone does not tell us whether it succeeded.
          }
        })();

        this.#synthesizer.speakTextAsync(
          this.inputText,
          (result) => {
            this.abortSignal.removeEventListener('abort', onAbort);
            if (result.reason === speechsdk.ResultReason.Canceled) {
              const details = speechsdk.CancellationDetails.fromResult(result);
              reject(
                new Error(
                  `Azure Speech synthesis was cancelled (${speechsdk.CancellationReason[details.reason]}): ` +
                    `${details.errorDetails || 'no details provided'}`,
                ),
              );
              return;
            }
            resolve();
          },
          (error) => {
            this.abortSignal.removeEventListener('abort', onAbort);
            reject(new Error(`Azure Speech synthesis failed: ${error}`));
          },
          sink,
        );
      });

      if (!this.abortSignal.aborted) {
        enqueue(byteStream.flush());
        flushPending(true);
      }
    } finally {
      finished = true;
      this.queue.close();
    }
  }
}
