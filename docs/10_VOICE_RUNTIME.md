# 10 — Voice Runtime

## Goal
Support browser test calls, inbound phone calls, controlled outbound calls, transcripts, recordings, tool calls, and transfers.

## Strategy
MVP: Mock provider, then real adapters. Current: two runtimes behind the adapter
interface — OpenAI Realtime (paid plans) and the in-house `standard` pipeline
(Azure Speech STT → Azure OpenAI chat → Azure Speech TTS, the only runtime the
free plan may use), both over LiveKit + Twilio/Telnyx SIP. `PipelineRouterService`
selects the pipeline from the plan's entitlement mix.

## Provider Interface
```ts
export interface VoiceRuntimeProvider {
  name: string;
  createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult>;
  updateAgent(input: UpdateRuntimeAgentInput): Promise<void>;
  createBrowserTestSession(input: CreateBrowserTestSessionInput): Promise<BrowserTestSessionResult>;
  startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult>;
  transferCall(input: TransferCallInput): Promise<void>;
  endCall(input: EndCallInput): Promise<void>;
  getTranscript(input: GetTranscriptInput): Promise<TranscriptResult>;
  getRecording(input: GetRecordingInput): Promise<RecordingResult>;
}
```

## Runtime Compiler
`Agent Spec JSON → validation → prompt compiler → tool compiler → knowledge config → compliance messages → provider config`

## Standard Call Events
```txt
call.created, call.started, caller.speech_started, agent.speech_started, agent.interrupted, knowledge.lookup, tool.requested, tool.succeeded, tool.failed, transfer.requested, transfer.completed, call.ended, recording.ready, transcript.ready, evaluation.completed, billing.metered
```

## Human Transfer Conditions
Caller requests human, angry caller, urgent case, tool failure, agent uncertainty, sensitive request, repeated misunderstanding.

## Reliability Requirements
Deduplicate webhooks, retry provider failures where safe, store raw webhook payloads, do not execute duplicate tool calls, record call state transitions, recover post-call processing asynchronously.
