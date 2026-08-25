import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '@livekit/agents';
import type { AgentSpec } from '@voiceforge/shared';
import {
  StandardPipelineConfigurationError,
  buildStandardSession,
  resolveStandardVoice,
  resolveSttLanguage,
  type StandardPipelineEnv,
} from './standard-pipeline';
import {
  AzureSpeechConfigurationError,
  AzureSpeechTTS,
  DEFAULT_AZURE_TTS_VOICE,
} from './azure-tts';

const baseSpec: AgentSpec = {
  schema_version: '1.0',
  name: 'VoiceForge Standard Pipeline',
  industry: 'testing',
  agent_type: 'inbound_receptionist',
  language: 'en',
  voice: { tone: 'calm and professional', allow_interruptions: true },
  identity: { business_name: 'VoiceForge', agent_name: 'Ava' },
  goals: ['Answer the caller'],
  required_fields: [],
  conversation_rules: {
    ask_one_question_at_a_time: true,
    confirm_critical_information: true,
    do_not_make_up_answers: true,
    fallback_to_human_when_unsure: true,
  },
  knowledge: { retrieval_mode: 'none', max_chunks: 0, source_ids: [] },
  tools: [],
  handoff: { enabled: false, conditions: [] },
  compliance: {
    ai_disclosure_required: true,
    recording_notice_required: false,
    opt_out_enabled: true,
    consent_required_for_outbound: true,
  },
  analytics: { success_events: [] },
};

function specWith(voice: Partial<AgentSpec['voice']>, language?: string): AgentSpec {
  return {
    ...baseSpec,
    ...(language ? { language } : {}),
    voice: { ...baseSpec.voice, ...voice },
  };
}

const completeEnv: StandardPipelineEnv = {
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_API_KEY: 'azure-openai-key',
  AZURE_VOICE_LLM_DEPLOYMENT: 'voice-brain',
  AZURE_SPEECH_KEY: 'azure-speech-key',
  AZURE_SPEECH_REGION: 'eastus',
};

describe('resolveStandardVoice', () => {
  it('uses an Azure-style voice from the spec', () => {
    expect(
      resolveStandardVoice(
        specWith({ voice_id: 'en-GB-SoniaNeural' }),
        'en-US-AvaMultilingualNeural',
      ),
    ).toBe('en-GB-SoniaNeural');
  });

  it('ignores Realtime voice names, which Azure Speech cannot resolve', () => {
    // A spec authored against the paid Realtime pipeline must not break the call
    // when the router sends it in-house instead.
    for (const realtimeVoice of ['marin', 'alloy', 'coral', 'shimmer']) {
      expect(
        resolveStandardVoice(specWith({ voice_id: realtimeVoice }), 'en-US-AvaMultilingualNeural'),
      ).toBe('en-US-AvaMultilingualNeural');
    }
  });

  it('falls back when the spec has no voice or only whitespace', () => {
    expect(
      resolveStandardVoice(specWith({ voice_id: undefined }), 'en-US-AvaMultilingualNeural'),
    ).toBe('en-US-AvaMultilingualNeural');
    expect(resolveStandardVoice(specWith({ voice_id: '   ' }), 'en-US-AvaMultilingualNeural')).toBe(
      'en-US-AvaMultilingualNeural',
    );
  });
});

describe('resolveSttLanguage', () => {
  it('widens a bare language subtag to a full locale', () => {
    // Azure rejects bare subtags like "en"; the spec schema permits them.
    expect(resolveSttLanguage(specWith({}, 'en'))).toEqual(['en-US']);
    expect(resolveSttLanguage(specWith({}, 'hi'))).toEqual(['hi-IN']);
  });

  it('passes through a locale that already has a region', () => {
    expect(resolveSttLanguage(specWith({}, 'en-AU'))).toEqual(['en-AU']);
  });

  it('includes language_configs keys for multilingual detection, spec language first', () => {
    const spec = specWith(
      {
        language_configs: {
          hi: { voice_id: 'hi-IN-SwaraNeural' },
          es: { voice_id: 'es-US-PalomaNeural' },
        },
      },
      'en',
    );
    expect(resolveSttLanguage(spec)).toEqual(['en-US', 'hi-IN', 'es-US']);
  });

  it('does not repeat a locale contributed by both language and language_configs', () => {
    const spec = specWith({ language_configs: { en: {} } }, 'en');
    expect(resolveSttLanguage(spec)).toEqual(['en-US']);
  });

  it('falls back to en-US when no locale can be resolved', () => {
    // "xx" has no known default region, so it cannot be sent to Azure as-is.
    expect(resolveSttLanguage(specWith({}, 'xx'))).toEqual(['en-US']);
  });

  it("caps multilingual locale candidates at Azure's limit of ten", () => {
    const spec = specWith(
      {
        language_configs: Object.fromEntries(
          ['hi', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar', 'nl'].map((language) => [
            language,
            {},
          ]),
        ),
      },
      'en',
    );
    const locales = resolveSttLanguage(spec);
    expect(locales).toHaveLength(10);
    expect(locales[0]).toBe('en-US');
  });

  it('truncates from the end, preserving declaration order of the survivors', () => {
    // The cap must drop the lowest-priority candidates (last language_configs
    // entries), never reorder or displace earlier ones.
    const spec = specWith(
      {
        language_configs: Object.fromEntries(
          ['hi', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar', 'nl'].map((language) => [
            language,
            {},
          ]),
        ),
      },
      'en',
    );
    expect(resolveSttLanguage(spec)).toEqual([
      'en-US',
      'hi-IN',
      'es-US',
      'fr-FR',
      'de-DE',
      'it-IT',
      'pt-BR',
      'ja-JP',
      'ko-KR',
      'zh-CN',
    ]);
  });

  it('does not let duplicates or unresolvable subtags consume capped slots', () => {
    // "en" duplicates the spec language and "xx" resolves to no locale; if
    // either counted against the cap, a real language at the end would be
    // dropped even though fewer than ten locales are actually sent to Azure.
    const spec = specWith(
      {
        language_configs: Object.fromEntries(
          ['en', 'xx', 'hi', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh'].map((language) => [
            language,
            {},
          ]),
        ),
      },
      'en',
    );
    expect(resolveSttLanguage(spec)).toEqual([
      'en-US',
      'hi-IN',
      'es-US',
      'fr-FR',
      'de-DE',
      'it-IT',
      'pt-BR',
      'ja-JP',
      'ko-KR',
      'zh-CN',
    ]);
  });
});

describe('buildStandardSession', () => {
  // AgentSession resolves the framework logger on construction. The worker CLI
  // normally initializes it during boot, which does not happen under vitest.
  beforeAll(() => {
    initializeLogger({ pretty: false, level: 'silent' });
  });

  it('builds a cascaded session with STT, LLM, TTS and the supplied VAD', () => {
    const vad = { label: 'silero.VAD' } as never;
    const session = buildStandardSession({ spec: baseSpec, vad, env: completeEnv });

    expect(session.stt).toBeDefined();
    expect(session.llm).toBeDefined();
    expect(session.tts).toBeDefined();
    expect(session.vad).toBe(vad);
  });

  it('points the LLM at the Azure resource, tolerating a trailing slash', () => {
    // withAzure() spreads options into the AzureOpenAI client, which ignores
    // `azureEndpoint`; an unresolved base URL would only surface as a runtime
    // error on the first call.
    for (const endpoint of [
      'https://example.openai.azure.com',
      'https://example.openai.azure.com/',
    ]) {
      const session = buildStandardSession({
        spec: baseSpec,
        vad: {} as never,
        env: { ...completeEnv, AZURE_OPENAI_ENDPOINT: endpoint },
      });
      expect(session.llm).toBeDefined();
    }
  });

  it('names every missing Azure variable instead of failing on the first one', () => {
    let error: unknown;
    try {
      buildStandardSession({ spec: baseSpec, vad: {} as never, env: {} });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StandardPipelineConfigurationError);
    const message = (error as Error).message;
    for (const name of [
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_API_KEY',
      'AZURE_VOICE_LLM_DEPLOYMENT',
      'AZURE_SPEECH_KEY',
      'AZURE_SPEECH_REGION',
    ]) {
      expect(message).toContain(name);
    }
  });

  it.each([
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_KEY',
    'AZURE_VOICE_LLM_DEPLOYMENT',
    'AZURE_SPEECH_KEY',
    'AZURE_SPEECH_REGION',
  ] as const)('refuses to build when %s is missing', (name) => {
    // Never silently degrade to Realtime: the pipeline is a billing decision.
    const env = { ...completeEnv, [name]: undefined };
    expect(() => buildStandardSession({ spec: baseSpec, vad: {} as never, env })).toThrow(
      StandardPipelineConfigurationError,
    );
  });

  it('treats whitespace-only configuration as missing', () => {
    expect(() =>
      buildStandardSession({
        spec: baseSpec,
        vad: {} as never,
        env: { ...completeEnv, AZURE_VOICE_LLM_DEPLOYMENT: '   ' },
      }),
    ).toThrow(/AZURE_VOICE_LLM_DEPLOYMENT/);
  });
});

describe('AzureSpeechTTS', () => {
  it('emits 24 kHz mono and reports itself as non-streaming', () => {
    const tts = new AzureSpeechTTS({ speechKey: 'key', speechRegion: 'eastus' });

    expect(tts.sampleRate).toBe(24_000);
    expect(tts.numChannels).toBe(1);
    // Non-streaming makes the framework wrap this in tts.StreamAdapter, which is
    // what keeps time-to-first-audio at one sentence rather than one response.
    expect(tts.capabilities.streaming).toBe(false);
    expect(tts.provider).toBe('azure');
  });

  it('prefers an explicit voice over the environment default', () => {
    const tts = new AzureSpeechTTS({
      speechKey: 'key',
      speechRegion: 'eastus',
      voice: 'en-GB-SoniaNeural',
    });

    expect(tts.voice).toBe('en-GB-SoniaNeural');
    expect(tts.model).toBe('en-GB-SoniaNeural');
  });

  it('falls back to a multilingual voice when none is configured', () => {
    const tts = new AzureSpeechTTS({ speechKey: 'key', speechRegion: 'eastus', voice: '  ' });
    expect(tts.voice).toBe(DEFAULT_AZURE_TTS_VOICE);
  });

  it('fails fast without Azure Speech credentials', () => {
    const previousKey = process.env.AZURE_SPEECH_KEY;
    const previousRegion = process.env.AZURE_SPEECH_REGION;
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;
    try {
      expect(() => new AzureSpeechTTS()).toThrow(AzureSpeechConfigurationError);
    } finally {
      if (previousKey !== undefined) process.env.AZURE_SPEECH_KEY = previousKey;
      if (previousRegion !== undefined) process.env.AZURE_SPEECH_REGION = previousRegion;
    }
  });

  it('rejects stream() so a missing StreamAdapter wrap is not silent', () => {
    const tts = new AzureSpeechTTS({ speechKey: 'key', speechRegion: 'eastus' });
    expect(() => tts.stream()).toThrow(/StreamAdapter/);
  });
});
