# ElevenLabs credits and low-latency calling: research for Voice V2

**Date:** 2026-09-02 · **Status:** research input to the approved Voice V2 rebuild
(`2026-09-01-voice-v2-rebuild-design.md`). Nothing here reopens the locked decisions: LiveKit and
Twilio are dropped, jambonz is the media plane, ElevenLabs does STT and TTS, the cascaded LLM is
Azure AI Foundry `gpt-5.4-mini` only, and Azure Realtime is the speech-to-speech option.
All web facts were accessed 2026-09-02; the URLs are in the Sources section.

---

## 1. Summary and recommendation

Cascaded mode should be: jambonz `listen` at 16 kHz L16 → ElevenLabs Scribe v2 Realtime
(`scribe_v2_realtime`, `pcm_16000`, `commit_strategy=vad`) → Azure `gpt-5.4-mini` over streaming
chat completions with `reasoning_effort: "none"`, no `temperature`, `verbosity: "low"`,
`max_completion_tokens` around 200 → ElevenLabs Flash v2.5 over the `stream-input` websocket at
`pcm_16000` (or `ulaw_8000` if jambonz stays at 8 kHz), all three sockets pre-opened before the
first audio frame arrives, and the first message played from a per-agent audio cache instead of
being generated. Route to ElevenLabs through `api.us.elevenlabs.io` and keep runtime, jambonz and
the Azure resource in the eastern US.

Flash v2.5 is the right TTS model: it is the only ElevenLabs model with both a stated ~75 ms
inference figure and a half-price credit rate. Multilingual v2 costs double and is slower; Turbo
v2.5 is deprecated.

Use Azure Realtime (`gpt-realtime` or `gpt-realtime-mini`) for paid plans when the caller speaks a
language the model handles natively and the customer has not chosen a custom ElevenLabs voice.
It removes the STT and TTS hops and the turn-taking problem, but it spends Azure tokens instead of
the 20 million ElevenLabs credits and it cannot use ElevenLabs voices.

## 2. What ElevenLabs credits buy

### 2.1 Rates (as published)

| Item | Published rate | Source |
| --- | --- | --- |
| Text to Speech, Multilingual v2 / Eleven v3 | "1 credit per character" | pricing page |
| Text to Speech, Flash v2.5 / Turbo v2.5 | "between 0.5 and 1 credit per character"; models page: "50% lower price per character for API generations" | pricing page, models page |
| Eleven v3 Conversational | not stated in credits; API price parity with Flash ($0.05 per 1k chars) suggests 0.5 credit per character: **unverified** | API pricing page |
| Speech to Text (Scribe) | "Speech to Text 330 credits per minute" | pricing page |
| Scribe v2 Realtime specifically | not stated in credits. API pricing lists Scribe v2 at $0.22 per hour and Scribe v2 Realtime at $0.39 per hour, a 1.77x ratio | API pricing page |
| Voice Changer and Voice Isolator | "1,000 credits per minute" | pricing page |
| Sound Effects | "200 credits per generation"; "40 credits per second when duration is specified" | pricing page, sound effects docs |
| Dubbing | 2,000 to 10,000 credits per minute depending on mode | pricing page |

**Flag on STT billing.** STT is credit-billed but not per character. The two ElevenLabs pricing
pages disagree about the STT-to-TTS ratio: the credits page says 330 credits per STT minute, while
the API page prices one Scribe v2 hour ($0.22) the same as 2,200 TTS characters ($0.10 per 1k),
which is about 37 characters per STT minute, not 330. Which schedule the owner's 20 million
credits follow is **unverified** and must be settled by one metered test call (read the account's
character count before and after a one-minute realtime STT session). The table below uses the
credits-page figure because that is the schedule that governs a credit pool.

### 2.2 Assumptions for the conversion

- Speech density: ElevenLabs bills Voice Changer and Voice Isolator at 1,000 credits per minute
  and describes that as "1,000 characters per minute of processed audio", so 1,000 characters ≈ 1
  minute of speech is ElevenLabs's own equivalence. Cross-check: 150 words per minute × 6
  characters per word including the space = 900 characters per minute.
- Agent talk share on a phone call: 50% (assumption). One call minute therefore costs about 500
  TTS characters.
- STT runs for the whole call (the caller stream is open continuously), so STT credits scale with
  call minutes, not talk share.
- Flash v2.5 is taken at 0.5 credit per character (the low end of the published range).

### 2.3 20,000,000 credits converted

| Component | Arithmetic | Result |
| --- | --- | --- |
| TTS only, Flash v2.5 | 20,000,000 ÷ 0.5 = 40,000,000 chars ÷ 1,000 = 40,000 speech minutes ÷ 0.5 talk share | **80,000 call minutes (1,333 h)** |
| TTS only, Flash v2.5 at the 1-credit end of the range | 20,000,000 ÷ 1,000 ÷ 0.5 | 40,000 call minutes (667 h) |
| TTS only, Multilingual v2 or Eleven v3 | 20,000,000 ÷ 1 ÷ 1,000 ÷ 0.5 | **40,000 call minutes (667 h)** |
| TTS only, v3 Conversational (if 0.5 credit/char, unverified) | same as Flash | 80,000 call minutes |
| STT only, Scribe at 330 credits per minute | 20,000,000 ÷ 330 | **60,606 call minutes (1,010 h)** |
| STT only, if realtime is billed 1.77x batch (unverified) | 330 × 1.77 = 584 credits/min; 20,000,000 ÷ 584 | 34,247 call minutes (571 h) |
| Cascaded call, Flash + Scribe | per minute: 500 × 0.5 = 250 TTS + 330 STT = 580 credits; 20,000,000 ÷ 580 | **34,483 call minutes (575 h)** |
| Cascaded call, Multilingual v2 + Scribe | 500 + 330 = 830 credits/min; 20,000,000 ÷ 830 | 24,096 call minutes (402 h) |
| Cascaded call, Flash + Scribe at the 1.77x realtime rate | 250 + 584 = 834; 20,000,000 ÷ 834 | 23,981 call minutes (400 h) |

Reading: with the recommended Flash + Scribe stack the credit pool covers roughly 24,000 to 35,000
cascaded call minutes. STT is the larger consumer at the published credit rate, so anything that
reduces STT minutes (hang up faster on voicemail, do not stream silence during long holds) saves
more credits than TTS tuning does. If the API-page ratio turns out to apply, STT is almost free
relative to TTS and the pool is closer to 75,000 call minutes.

## 3. Feature menu

Ranked by value per unit of effort against the V2 architecture (`apps/voice-runtime`,
`telephony-v2`, agent spec in `packages/shared/src/schemas/agent-spec.ts`). Effort: small = under
a day inside existing seams, medium = a few days including a schema or UI change, large = a week
or more or an operational process.

| Rank | Feature | What the customer sees | Effort | UI work | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | ElevenLabs voice picker with preview | Pick from the ElevenLabs library voices (10,000+ per the voices docs) with a play button; stored in `spec.voice.voice_id` | Small | Yes (replace the free-text `voice_id` field) | `voice_id` already exists in the spec and is honored by the plan's cascaded engine. Today the field is a bare string and the realtime path only accepts OpenAI voice names (`agent-runtime.ts:resolveRealtimeVoice`). |
| 2 | Speaking speed and per-language voice actually applied | The `speaking_rate` slider and `language_configs` in the editor change the call | Small | Existing UI | `spec.voice.speaking_rate` and `allow_interruptions` are defined in the schema (`agent-spec.ts:31-47`) but the only consumer is `apps/web/components/form-mode-editor.tsx`; no runtime reads them. Map `speaking_rate` to `voice_settings.speed` (ElevenLabs range 0.7 to 1.2, so clamp). |
| 3 | STT keyterm boosting from the agent spec | Business, product and person names are transcribed correctly | Small | No | Scribe realtime accepts `keyterms` on the websocket URL; derive from `identity.business_name`, required-field enum values and tool names. |
| 4 | Instant Voice Clone for the customer's own brand voice | Upload under two minutes of audio, get a voice usable on calls within a minute | Small to medium | Yes (upload, consent checkbox, preview) | `POST /v1/voices/add` with `remove_background_noise=true`. IVC "available on most plans". All clones live in our one ElevenLabs workspace, so per-plan voice slot limits are a shared ceiling: **unverified** count, check before launch. |
| 5 | Voice Design (voice from a text description) | Type "warm Indian-English female, mid 30s" and get three previews to pick from | Small to medium | Yes | `POST /v1/text-to-voice/design` returns three previews (`generated_voice_id` + base64 audio); save with `/v1/text-to-voice`. Credit cost per design: **unverified**. |
| 6 | Word-timed transcripts | Click a word in the transcript and the recording jumps there | Small (runtime) + small (UI) | Yes | Scribe realtime `include_timestamps=true` returns `committed_transcript_with_timestamps`. Store offsets on the CallEvent; the live SSE path already carries transcript deltas. |
| 7 | Multilingual agents with auto language detection | Caller switches to Hindi, the agent follows | Medium | Partial (language_configs exists) | Scribe supports 90+ languages and `include_language_detection`; Flash v2.5 supports 32 languages. Switch `voice_id` per detected language using `language_configs`. Prompt must tell gpt-5.4-mini to answer in the caller's language. |
| 8 | Pronunciation dictionaries | Brand names are pronounced the customer's way | Medium | Yes | `pronunciation_dictionary_locators` on the TTS websocket init message. Needs a dictionary CRUD screen. |
| 9 | Background ambience during calls | Soft office or call-center ambience under the agent voice so gaps feel natural | Small | Toggle only | One-off Sound Effects generation (200 credits, loopable per the docs), mixed at low gain in the runtime output path. Also masks turn latency. |
| 10 | Post-call diarized transcript and audio events | "Agent / Caller" labels with speaker turns and non-speech tags on the recording | Medium | Small | Batch Scribe v2 supports diarization up to 32 speakers; realtime does not list diarization. Requires recording both legs (jambonz `listen` with `mixType: stereo`). Costs a second pass of STT credits, so gate by plan. |
| 11 | Entity extraction into required fields | Phone numbers, emails and dates spoken by the caller land in the captured fields automatically | Medium | Small | Scribe `entity_detection` (65 entity types on v2 Realtime per the models page) at "additional cost" (STT docs). |
| 12 | Professional Voice Clone | Studio-grade clone of the founder's voice | Large (process) | Yes | Requires Creator plan or above, "Voice-captcha" verification by the voice owner, slots are 3 on Scale and 10 on Business. ElevenLabs states PVCs are slower than default voices and IVCs on Flash v2.5. Not worth building until a customer pays for it. |
| 13 | Forced alignment | Timestamps for imported transcripts | Small | No | Redundant: Scribe realtime already returns word timestamps. Skip. |
| 14 | Voice Changer, Dubbing | Change a recording's voice; translate a recording | n/a | n/a | Voice Changer is file-based (5-minute max, no realtime path documented) and Dubbing is for content. Neither fits a calling product. Skip. |

## 4. Latency budget

Targets are for a PSTN call, measured from the moment the caller stops speaking to the moment the
caller hears the first agent syllable. Human conversational gaps are around 500 ms; the illustrated
primer used for the reference budget puts a well-tuned cascaded agent at 1,293 ms and calls 1,500
ms "an important target to aim for". ITU-T G.114 says one-way transport delay should not exceed 400
ms for planning and that interactive voice is affected well below that.

Reference cascaded breakdown (Kwindla Hultman Kramer's primer, WebRTC to a local mic): transcription
and endpointing 300 ms, LLM time to first byte 650 ms, sentence aggregation 20 ms, TTS time to first
byte 120 ms, two jitter buffers 40 ms each, opus coding 21 ms each way, total 1,293 ms.

### 4.1 Target budget for our phone path

| Stage | Cascaded target (ms) | Speech-to-speech target (ms) | Basis |
| --- | --- | --- | --- |
| Caller mouth → carrier → jambonz → runtime (G.711 20 ms packetization, carrier transit, rtpengine) | 100 | 100 | assumption; carrier dependent, measure in spike |
| Endpointing silence (deciding the caller finished) | 350 | 200 to 500 | Scribe `vad_silence_threshold_secs` (default unverified); Azure Realtime `silence_duration_ms` default 200 (Realtime docs), Voice Live default 500 |
| STT final after endpoint | 200 | 0 (inside the model) | Scribe v2 Realtime "~150 ms" excluding network, plus one US round trip |
| LLM time to first token | 400 | 500 (audio out, unverified) | gpt-5.4-mini with `reasoning_effort: none`; unverified until measured. Reference budget shows 650 ms for a typical LLM |
| First TTS chunk ready (clause or sentence boundary) | 100 | 0 | ~10 tokens at 100 tokens/s (assumption) |
| TTS time to first byte | 150 | 0 | Flash v2.5 ~75 ms model + ElevenLabs's published 100 to 150 ms TTFB for North America |
| Runtime → jambonz → carrier → callee ear, including FreeSWITCH jitter buffer | 140 | 140 | 100 assumed transit + 40 jitter buffer (reference budget) |
| **Total** | **1,440** | **~940 to 1,240** | |
| With speculative LLM start on partials (LLM overlaps endpointing) | **~1,050** | | see action 5 |
| Greeting only (played from cache) | **< 250 after answer** | n/a | see action 2 |

WebSocket transport to Azure Realtime adds "~200 ms" versus WebRTC per the Azure Realtime docs; that
is inside the speech-to-speech row.

### 4.2 What the current LiveKit runtime gets wrong today

All paths are under `apps/livekit-agent/src/`.

1. **Two silence timers stack.** `standard-pipeline.ts` sets Azure STT
   `segmentationSilenceTimeoutMs: 320` and then LiveKit endpointing `minDelay: 300`, `maxDelay:
   2000`. The STT final only arrives after 320 ms of silence and the framework then waits at least
   another 300 ms after it, so the worst-case floor before the LLM is asked is around 620 ms plus
   the STT round trip. `preemptiveGeneration` is enabled and hides part of this, but the design
   pays for silence twice.
2. **Greeting is generated live on every call.** `index.ts` calls
   `session.generateReply({ instructions: firstReplyInstruction(spec) })` right after
   `session.start`; `firstReplyInstruction` returns `Say exactly: "<first_message>"`
   (`agent-runtime.ts`). A fixed string goes through LLM TTFT plus TTS TTFB on every answered
   call.
3. **TTS is non-streaming and drops its socket on barge-in.** `azure-tts.ts` declares
   `{ streaming: false }` so each sentence is a separate `speakTextAsync`; on abort
   `#cancelSynthesis` closes the shared synthesizer, so the sentence after any interruption pays a
   fresh websocket handshake.
4. **Database lookups sit in the answer path.** `index.ts` runs `resolveCallAttribution` and
   `loadAgentSpec` (Prisma) after `ctx.connect()` and before the session starts. V2 already moves
   this to a context endpoint; it should also be prefetched at token-mint time.
5. **Interruption settings are ignored.** `allow_interruptions` and `speaking_rate` exist in the
   spec (`packages/shared/src/schemas/agent-spec.ts:31-33`) and are edited in the web form, but no
   runtime file reads them; the realtime session is built with only `{ voice }`
   (`index.ts`), and the cascaded session never sets interruption thresholds.
6. **Temperature on a reasoning model.** `standard-pipeline.ts` passes `temperature: 0.4` to the
   `AZURE_VOICE_LLM_DEPLOYMENT` (`gpt-5.4-mini`). Azure documents `temperature` as unsupported on
   reasoning models, and the API's own adapter already guards this
   (`apps/api/src/llm/adapters/azure-aifoundry.adapter.ts:142`, `supportsTemperature` returns
   false for `gpt-5`). The V2 plan repeats the mistake: `AzureChatConfig` in
   `docs/superpowers/plans/parts/02a-phase2-runtime-core.md` sends `temperature: cfg.temperature
   ?? DEFAULT_TEMPERATURE` on every request and never sets `reasoning_effort`.
7. **Every call starts cold.** Only the Silero VAD is prewarmed (`prewarm` in `index.ts`); the STT,
   LLM and TTS clients are constructed inside `buildStandardSession` per call.
8. **Region is not pinned.** Deploy runs in `us-east-1` (`.github/workflows/deploy-aws-ec2.yml:41`);
   the Azure region and the ElevenLabs edge are whatever the default endpoints resolve to.

## 5. Ten concrete latency actions

Ordered by expected saving per unit of work. Savings are estimates; the spike replaces them with
measurements.

1. **Send `reasoning_effort: "none"` (fall back to the lowest value the deployment accepts),
   `verbosity: "low"`, `max_completion_tokens` ≈ 200, and no `temperature` on every gpt-5.4-mini
   voice request.** Azure lists `none` for "latency-critical work ... such as voice" and notes it
   "can increase speed"; the default is not `none`, so today every turn spends reasoning tokens
   before the first visible token, and `temperature` is rejected on reasoning models. Saving:
   likely several hundred ms of TTFT (unverified). Lands in `apps/voice-runtime/src/azure-chat.ts`
   (plan Task 2.5, `AzureChatConfig`) and, until the flip, `apps/livekit-agent/src/standard-pipeline.ts`.
2. **Pre-synthesize the first message per (agent version, voice_id, TTS model, output format) and
   play it from cache on stream start.** Saving: the whole LLM TTFT + TTS TTFB on the greeting,
   roughly 0.5 to 1.0 s, so the callee hears a voice under 250 ms after answering. Lands in the
   cascaded engine `start()` (`cascaded-engine.ts`, replacing `void agentTurn(input.firstReply)`),
   with the audio cached in Redis by the API and invalidated on publish.
3. **Open the Scribe, Flash and Azure sockets when the API mints the stream token, not when the
   first frame arrives.** The API knows a call is coming at webhook time (inbound) or dial time
   (outbound). Saving: two to three TLS + websocket handshakes, 100 to 300 ms off call start.
   Lands in the voice-runtime session manager and `elevenlabs.ts` (`openSttStream`,
   `openTtsStream`), keyed by callId with a short TTL.
4. **Own one endpointing timer.** Use Scribe `commit_strategy=vad` with
   `vad_silence_threshold_secs` around 0.35 to 0.4 and `min_silence_duration_ms` set explicitly
   (defaults are unverified), and do not add a second app-level silence wait on top; only keep a
   hard cap for the case where no commit arrives. Saving: 150 to 300 ms versus a 500 ms class
   default, and no double counting. Lands in the STT URL builder in `elevenlabs.ts` (the plan
   currently sets only `commit_strategy=vad`).
5. **Speculative LLM start on stable partials.** When a `partial_transcript` has not changed for
   about 200 ms, start the chat completion with it; on `committed_transcript`, keep the stream if
   the text matches, otherwise abort and re-issue. Saving: overlaps LLM TTFT with the endpointing
   silence, 200 to 400 ms. Lands in `cascaded-engine.ts`, whose `partial` handler is currently a
   no-op. Azure's in-memory prompt cache makes the re-issue cheap (identical prefix over 1,024
   tokens is cached, 128-token granularity).
6. **Emit the first TTS chunk at the first clause boundary, not the first sentence.** Split on
   comma or about 40 characters for the first chunk, then by sentence; set
   `generation_config.chunk_length_schedule` low (for example `[50, 120, 160, 250]`, each item is
   allowed 50 to 500) and send `flush: true` on the final chunk of a turn. Saving: 100 to 200 ms
   of token streaming before audio starts. Lands in `splitSentences` (`cascaded-engine.ts`) and the
   init message in `openTtsStream`.
7. **Do not reconnect TTS on barge-in; kill audio at jambonz first.** Send `{"type":"killAudio"}`
   on the jambonz socket the instant speech starts (jambonz flushes queued audio), then switch to a
   pre-opened spare TTS socket instead of `tts.close(); tts = await openTts()` as in the plan.
   Also require about 250 ms of speech or a two-word partial before treating it as an interruption,
   so "mm-hm" does not cut the agent off. Saving: 100 to 200 ms after each interruption and fewer
   false stops. Lands in `bargeIn()` (`cascaded-engine.ts`) and the jambonz transport's
   `onClearAudio`.
8. **Pin regions.** Runtime and jambonz in `us-east-1`; ElevenLabs via `api.us.elevenlabs.io`
   (ElevenLabs states 100 to 150 ms TTFB for North America); Azure resource in `eastus2`, which
   hosts `gpt-realtime` (Global standard) and Voice Live. Prefer Data Zone Standard US over Global
   Standard where the model allows, because Global Standard routes each request "to the data center
   with the best availability" and Azure warns latency can vary above the usage tier. Saving: 20 to
   80 ms per hop and lower variance. Lands in env (`ELEVENLABS_BASE_URL`, `AZURE_OPENAI_ENDPOINT`)
   and the deployment choice; note `gpt-5.4-mini` appears only as GlobalStandard in Azure's quota
   tables, so its regional option is **unverified**.
9. **Match sample rates end to end.** Ask jambonz for `listen` at `sampleRate: 16000` (it supports
   8000/16000/24000/48000/64000, L16 binary frames) and send Scribe `audio_format=pcm_16000`; ask
   Flash for `pcm_16000` and set `bidirectionalAudio.sampleRate: 16000`, so the runtime never
   resamples and forwards fixed 20 ms frames (640 bytes at 16 kHz, jambonz's recommended fixed
   length). Saving: 10 to 30 ms and no resampling artifacts. Lands in the `listen` verb builder in
   `telephony-v2` and the transport in `apps/voice-runtime`.
10. **Keep the prompt prefix stable and short.** Put `buildVoiceForgeInstructions` output and the
    tool schemas first and unchanged, append-only history, no per-turn timestamps in the system
    message, and trim tool descriptions. Azure caches identical prefixes over 1,024 tokens
    automatically on GPT-4o and later, so a stable prefix cuts prefill time on every turn and cuts
    input cost. Saving: tens of ms per turn, more on long calls. Lands in `prompt.ts` and
    `azure-chat.ts`.

Instrumentation is the prerequisite for all ten: stamp `speech_stopped`, `stt_committed`,
`llm_first_token`, `tts_first_byte`, `audio_sent` per turn and post them as call events so the
budget table above is replaced by production percentiles within a week of the flip.

## 6. Risks and unknowns

- **ElevenLabs concurrency caps.** Published limits per plan: Flash 4 / 6 / 10 / 20 / 30 / 30
  (Free through Business), Multilingual v2 2 / 3 / 5 / 10 / 15 / 15, realtime STT 6 / 9 / 15 /
  30 / 45 / 45, Enterprise "Elevated". A cascaded call holds one STT stream for its whole duration
  and one TTS generation while speaking, so Business caps concurrent calls at roughly 30 to 45 with
  no headroom. Whether the owner's 20 million credits sit on an Enterprise contract with elevated
  limits is **unverified**; confirm before sizing campaign `max_concurrent`.
- **STT credit rate.** 330 credits per minute (credits page) versus the API page's dollar rates
  imply a 9x different STT-to-TTS ratio (Section 2.1). Settle with one metered call. Whether
  Scribe v2 Realtime is billed above batch Scribe in credits is **unverified**.
- **gpt-5.4-mini behaviour.** It is a reasoning model; `temperature` is rejected; whether the
  deployment accepts `reasoning_effort: "none"` (documented for gpt-5.4 and later, `minimal` is
  "not supported with gpt-5.1 or greater") is **unverified** for the mini variant. Its TTFT from
  us-east-1 is unmeasured. Azure Tier 1 quota is 1,000 RPM and 1,000,000 TPM GlobalStandard, ample.
- **Azure Realtime quota and session limits.** `gpt-realtime` GlobalStandard Tier 1 is 200 RPM and
  100,000 TPM. At the documented ~10 input and ~20 output audio tokens per second, one talking call
  is about 1,800 tokens per minute, so 100,000 TPM is roughly 55 concurrent calls before 429s;
  `gpt-4o-realtime-preview` at 6,000 TPM is unusable at scale. Sessions end at 60 minutes, so
  `maxDurationSeconds` must stay below that. Audio-token pricing per minute is **unverified** (the
  Azure pricing page did not render figures); it is certainly higher per minute than cascaded, so
  the plan-based `pipelineMix` router stays the cost control.
- **Voice Live versus raw Realtime.** Voice Live adds `azure_semantic_vad`, `remove_filler_words`,
  `azure_deep_noise_suppression`, `server_echo_cancellation`, Azure and custom voices, and can host
  `gpt-5.4-mini` via bring-your-own-model. It is a credible alternative for the speech-to-speech
  tier, but it does not use ElevenLabs voices or credits, and its pricing tiers (Pro, Basic, Lite)
  are unpriced in what I could fetch: **unverified**. Keep it as the fallback if raw Realtime's
  turn-taking disappoints.
- **India calling.** The user's carrier is +91. With jambonz in us-east-1 the PSTN leg crosses the
  Pacific or Atlantic twice; assume 250 ms extra round trip (unverified). ElevenLabs has an India
  residency endpoint (`api.in.residency.elevenlabs.io`) and Azure `centralindia` has `gpt-realtime`
  (Standard) and Voice Live, so a Mumbai jambonz edge is a later option, not a V2 requirement.
- **Cost blow-ups.** Multilingual v2 or v3 doubles TTS credits; post-call diarization doubles STT
  credits; entity detection and keyterms are "additional cost" (amount unverified); speculative
  LLM starts add aborted requests (cheap with prompt caching, but counted against RPM).
- **Deprecations.** Turbo v2.5 is marked deprecated; `optimize_streaming_latency` is deprecated on
  the REST stream endpoint, so do not build on either. ElevenLabs docs pages moved during this
  research (several `/docs/capabilities/*` URLs return 404); pin the API reference URLs in code
  comments, not the guide URLs.
- **Turn-taking is ours in cascaded mode.** Scribe realtime does not offer diarization or filler
  suppression; false barge-ins on backchannels are the main quality risk and need the guard in
  action 7 plus tuning on real calls.

**Spikes to run (each a throwaway script, before Phase 2 code):**
(a) one-minute metered Scribe realtime call, read credits consumed; (b) gpt-5.4-mini TTFT with
`reasoning_effort: none` versus default from the prod host, 20 samples; (c) Scribe VAD defaults
and commit latency at `pcm_16000` versus `ulaw_8000`; (d) Flash TTFB at `pcm_16000` via
`api.us.elevenlabs.io` versus the default host; (e) whether a multi-context TTS websocket exists
(the docs URL 404'd) or a spare-socket swap is needed; (f) Azure Realtime per-call token burn and
first-audio latency over websocket from us-east-1; (g) end-to-end mouth-to-ear on a real VoiceLink
call with a loopback echo app to fix the transport rows of the budget.

## 7. Sources

All accessed 2026-09-02.

ElevenLabs
- Models overview (latency figures, language counts, deprecations, concurrency table, footnote "Excluding application & network latency"): https://elevenlabs.io/docs/overview/models
- Pricing (credit rates per product, plan credits, PVC slots): https://elevenlabs.io/pricing
- API pricing (dollar rates: TTS $0.10 and $0.05 per 1k chars, Scribe v2 $0.22/h, Scribe v2 Realtime $0.39/h, isolator/changer $0.12/min): https://elevenlabs.io/pricing/api
- Speech to Text capability (diarization, timestamps, batch concurrency formula, "additional cost" note): https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- Realtime STT websocket reference (`/v1/speech-to-text/realtime`, audio formats, `commit_strategy`, VAD params, `keyterms`, `include_timestamps`, message types, regional hosts): https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- Realtime STT cookbook (`scribe_v2_realtime`, partial vs committed): https://elevenlabs.io/docs/cookbooks/speech-to-text/streaming
- Scribe v2 Realtime announcement (under 150 ms, 90 languages, VAD, manual commit): https://elevenlabs.io/blog/introducing-scribe-v2-realtime
- TTS websocket `stream-input` reference (output formats incl. pcm_8000/ulaw_8000/pcm_16000/pcm_24000, `chunk_length_schedule` default `[120,160,250,290]`, `voice_settings.speed` 0.7 to 1.2, alignment, regional hosts): https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
- TTS stream REST reference (`optimize_streaming_latency` deprecated, output format tiers): https://elevenlabs.io/docs/api-reference/text-to-speech/stream
- Latency best practices (Flash ~75 ms, regional TTFB 100 to 150 ms, `api.us.elevenlabs.io`, voice type ordering): https://elevenlabs.io/docs/best-practices/latency-optimization
- Voices (IVC under two minutes, PVC Creator plan and voice-captcha, Voice Design three previews): https://elevenlabs.io/docs/overview/capabilities/voices
- IVC create endpoint: https://elevenlabs.io/docs/api-reference/voices/ivc/create
- Voice Design endpoint: https://elevenlabs.io/docs/api-reference/text-to-voice/design
- Voice Changer (models, 1,000 characters per minute, 5-minute max): https://elevenlabs.io/docs/capabilities/voice-changer
- Voice Isolator (1,000 characters per minute, 1 hour / 500 MB): https://elevenlabs.io/docs/overview/capabilities/voice-isolator
- Sound Effects (40 credits per second, 30 s max, looping): https://elevenlabs.io/docs/capabilities/sound-effects
- Dubbing: https://elevenlabs.io/docs/capabilities/dubbing
- Forced Alignment (same rate as STT, no diarization): https://elevenlabs.io/docs/capabilities/forced-alignment

Azure
- Voice Live overview (models incl. BYOM for gpt-5.4-mini, pricing tiers, ~10/~20 audio tokens per second): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live
- Voice Live how-to (`azure_semantic_vad`, `remove_filler_words`, noise suppression, echo cancellation, Azure/custom voices, defaults): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to
- Speech regions incl. Voice Live table: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=voice-live
- GPT Realtime API how-to (server_vad/semantic_vad, defaults, 60-minute sessions, 24 kHz pcm16, WebSocket ~200 ms): https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/realtime-audio
- Realtime over WebSockets (`/openai/v1/realtime?model=`): https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/realtime-audio-websockets
- Reasoning models (`reasoning_effort` values, `none` for voice, temperature unsupported, `max_completion_tokens`): https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/reasoning
- Prompt caching (1,024-token minimum, 128-token increments, 5 to 10 minute in-memory retention): https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching
- Quotas and limits (tier tables for gpt-5.4-mini and gpt-realtime, Global Standard routing note): https://learn.microsoft.com/en-us/azure/ai-foundry/openai/quotas-limits

Telephony and latency references
- jambonz `listen` verb (sample rates, L16 frames, `killAudio`, 320/640-byte frames): https://docs.jambonz.org/verbs/verbs/listen
- jambonz `dial` verb (confirmHook on answer, `answerOnBridge`, status values): https://docs.jambonz.org/verbs/verbs/dial
- Voice AI and Voice Agents illustrated primer (1,293 ms reference budget, 500 ms human gap, 1,500 ms target): https://voiceaiandvoiceagents.com/
- Daily, "The world's fastest voice bot" (500 ms typical, 800 ms unnatural): https://www.daily.co/blog/the-worlds-fastest-voice-bot/
- ITU-T G.114 summary (400 ms planning limit): https://www.itu.int/dms_pubrec/itu-t/rec/g/T-REC-G.114-200305-I!!SUM-HTM-E.htm

Repository files cited
- `apps/livekit-agent/src/standard-pipeline.ts`, `apps/livekit-agent/src/azure-tts.ts`, `apps/livekit-agent/src/index.ts`, `apps/livekit-agent/src/agent-runtime.ts`
- `apps/api/src/llm/adapters/azure-aifoundry.adapter.ts`, `apps/api/src/voice/adapters/openai-realtime.adapter.ts`, `apps/api/src/voice/pipeline-router.service.ts`
- `packages/shared/src/schemas/agent-spec.ts`, `apps/web/components/form-mode-editor.tsx`
- `docs/superpowers/specs/2026-09-01-voice-v2-rebuild-design.md`, `docs/superpowers/plans/parts/00-header-phase0.md`, `02a-phase2-runtime-core.md`, `02b-phase2-runtime-engines.md`
- `.github/workflows/deploy-aws-ec2.yml`
