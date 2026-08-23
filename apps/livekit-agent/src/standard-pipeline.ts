import { voice, type VAD, type llm } from '@livekit/agents';
import * as azure from '@livekit/agents-plugin-azure';
import * as openai from '@livekit/agents-plugin-openai';
import type { AgentSpec } from '@voiceforge/shared';
import { AzureSpeechTTS, DEFAULT_AZURE_TTS_VOICE } from './azure-tts.js';

/**
 * The in-house ("standard") STT → LLM → TTS pipeline: Azure Speech recognition,
 * an Azure OpenAI chat deployment as the brain, and Azure Speech synthesis.
 *
 * This is what free-plan calls run on, and half of starter-plan calls. Paid
 * plans keep the single-model Realtime pipeline, so everything here is tuned for
 * the one thing a cascaded pipeline has to win at to stay usable on a phone
 * call: time to first audio.
 */

/** Azure Speech streams recognition at 16 kHz mono; sending anything else forces a resample. */
const AZURE_STT_SAMPLE_RATE = 16_000;
const AZURE_STT_CHANNELS = 1;

/**
 * Azure OpenAI data-plane version that supports streamed tool calls on chat
 * completions. Pinned rather than floating so a service-side default change
 * cannot silently alter tool-calling behavior mid-release.
 */
const DEFAULT_AZURE_OPENAI_API_VERSION = '2024-10-21';

/**
 * Ends the user's turn quickly while still tolerating mid-sentence pauses.
 * Azure's own default (500 ms) is tuned for dictation, not conversation.
 */
const STT_SEGMENTATION_SILENCE_TIMEOUT_MS = 320;

/**
 * Endpointing floor/ceiling for the framework's turn detector. The floor is
 * deliberately below the framework default (500 ms) because a cascaded pipeline
 * pays STT + LLM + TTS latency after the turn ends, and that budget has to come
 * from somewhere.
 */
const ENDPOINTING_MIN_DELAY_MS = 300;
const ENDPOINTING_MAX_DELAY_MS = 2_000;

/**
 * Low temperature keeps a small/fast chat deployment on-script: it has to honor
 * the Agent Spec's rules and emit well-formed tool calls, not write prose.
 */
const STANDARD_LLM_TEMPERATURE = 0.4;

export interface StandardPipelineEnv {
  AZURE_OPENAI_ENDPOINT?: string | undefined;
  AZURE_OPENAI_API_KEY?: string | undefined;
  AZURE_OPENAI_API_VERSION?: string | undefined;
  AZURE_VOICE_LLM_DEPLOYMENT?: string | undefined;
  AZURE_SPEECH_KEY?: string | undefined;
  AZURE_SPEECH_REGION?: string | undefined;
  AZURE_TTS_VOICE?: string | undefined;
}

/**
 * Thrown when a call is routed to the standard pipeline but the worker has no
 * Azure configuration. Failing loudly here is correct: the alternative is
 * silently serving free-plan traffic on the paid Realtime pipeline.
 */
export class StandardPipelineConfigurationError extends Error {
  override readonly name = 'StandardPipelineConfigurationError';
}

/**
 * Resolves the synthesis voice for a standard-pipeline call.
 *
 * `spec.voice.voice_id` is shared with the Realtime pipeline, whose voice names
 * (`marin`, `alloy`, …) are meaningless to Azure Speech. Only Azure-style names
 * (`en-US-AvaMultilingualNeural`) are honored; anything else falls back to the
 * configured deployment voice so a spec authored for Realtime does not break the
 * call with an unknown-voice error.
 */
export function resolveStandardVoice(
  spec: AgentSpec,
  fallbackVoice: string,
): string {
  const specVoice = spec.voice.voice_id?.trim();
  if (specVoice && isAzureVoiceName(specVoice)) return specVoice;
  return fallbackVoice;
}

/** Azure neural voice names look like `<lang>-<REGION>-<Name>Neural`. */
function isAzureVoiceName(voiceId: string): boolean {
  return /^[a-z]{2,3}(-[A-Za-z]+)?-[A-Z]{2}-.+$/.test(voiceId);
}

/**
 * Resolves the recognition language list for a standard-pipeline call.
 *
 * `spec.language` may be a bare language subtag (`en`), which Azure rejects —
 * it requires full BCP-47 locales. Bare tags are widened to a default locale.
 * The keys of `language_configs` are included so multilingual agents get Azure's
 * automatic language detection instead of being pinned to one locale.
 */
export function resolveSttLanguage(spec: AgentSpec): string[] {
  const locales: string[] = [];
  const push = (value: string | undefined): void => {
    const locale = toAzureLocale(value);
    if (locale && !locales.includes(locale)) locales.push(locale);
  };

  // The spec's own language leads, so it wins when Azure has to pick a default.
  push(spec.language);
  for (const language of Object.keys(spec.voice.language_configs ?? {})) {
    push(language);
  }

  return locales.length > 0 ? locales : ['en-US'];
}

/** Default region for language subtags that arrive without one. */
const DEFAULT_LOCALE_BY_LANGUAGE: Record<string, string> = {
  en: 'en-US',
  es: 'es-US',
  fr: 'fr-FR',
  de: 'de-DE',
  pt: 'pt-BR',
  hi: 'hi-IN',
  it: 'it-IT',
  nl: 'nl-NL',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  ar: 'ar-SA',
};

function toAzureLocale(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('-')) return trimmed;
  const lower = trimmed.toLowerCase();
  return DEFAULT_LOCALE_BY_LANGUAGE[lower] ?? undefined;
}

export interface BuildStandardSessionOptions {
  spec: AgentSpec;
  /** Preloaded Silero VAD. Loading it per job would add seconds to call setup. */
  vad: VAD;
  env?: StandardPipelineEnv;
}

/**
 * Builds the cascaded AgentSession for a standard-pipeline call.
 *
 * Fails fast when Azure is unconfigured rather than degrading to a different
 * pipeline, because pipeline choice is a billing decision made upstream by the
 * router — the worker is not entitled to override it.
 */
export function buildStandardSession(
  options: BuildStandardSessionOptions,
): voice.AgentSession<llm.ToolContext> {
  const { spec, vad } = options;
  const env = options.env ?? (process.env as StandardPipelineEnv);

  const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = env.AZURE_OPENAI_API_KEY?.trim();
  const deployment = env.AZURE_VOICE_LLM_DEPLOYMENT?.trim();
  const missing = [
    endpoint ? undefined : 'AZURE_OPENAI_ENDPOINT',
    apiKey ? undefined : 'AZURE_OPENAI_API_KEY',
    deployment ? undefined : 'AZURE_VOICE_LLM_DEPLOYMENT',
    env.AZURE_SPEECH_KEY?.trim() ? undefined : 'AZURE_SPEECH_KEY',
    env.AZURE_SPEECH_REGION?.trim() ? undefined : 'AZURE_SPEECH_REGION',
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new StandardPipelineConfigurationError(
      `The standard voice pipeline requires ${missing.join(', ')} to be configured on the agent worker.`,
    );
  }

  const locales = resolveSttLanguage(spec);

  const stt = new azure.STT({
    speechKey: env.AZURE_SPEECH_KEY,
    speechRegion: env.AZURE_SPEECH_REGION,
    sampleRate: AZURE_STT_SAMPLE_RATE,
    numChannels: AZURE_STT_CHANNELS,
    language: locales,
    segmentationSilenceTimeoutMs: STT_SEGMENTATION_SILENCE_TIMEOUT_MS,
    // Punctuation helps the sentence tokenizer split TTS input at natural
    // boundaries, and gives the LLM cleaner turns to reason over.
    explicitPunctuation: true,
  });

  // `baseURL` rather than `azureEndpoint`: withAzure() spreads its options into
  // the AzureOpenAI client, which only recognizes `endpoint`/`deployment`, so
  // the `azure*` options are silently dropped and the client is left without a
  // resource URL. `model` carries the deployment name, which the client turns
  // into the `/deployments/<name>` path segment.
  const chat = openai.LLM.withAzure({
    model: deployment as string,
    baseURL: `${(endpoint as string).replace(/\/+$/, '')}/openai`,
    apiKey: apiKey as string,
    apiVersion: env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION,
    temperature: STANDARD_LLM_TEMPERATURE,
  });

  const tts = new AzureSpeechTTS({
    speechKey: env.AZURE_SPEECH_KEY,
    speechRegion: env.AZURE_SPEECH_REGION,
    voice: resolveStandardVoice(spec, env.AZURE_TTS_VOICE?.trim() || DEFAULT_AZURE_TTS_VOICE),
    ...(locales[0] ? { language: locales[0] } : {}),
  });

  return new voice.AgentSession({
    stt,
    llm: chat,
    tts,
    vad,
    turnHandling: {
      endpointing: {
        minDelay: ENDPOINTING_MIN_DELAY_MS,
        maxDelay: ENDPOINTING_MAX_DELAY_MS,
      },
      // Start generating on the predicted end of turn so LLM time overlaps the
      // endpointing delay instead of being spent after it.
      preemptiveGeneration: { enabled: true },
    },
  });
}
