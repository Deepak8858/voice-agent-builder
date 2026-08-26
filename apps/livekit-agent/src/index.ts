import {
  ServerOptions,
  cli,
  defineAgent,
  voice,
  type JobProcess,
  type VAD,
  type llm,
  type JobContext,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import {
  buildVoiceForgeInstructions,
  firstReplyInstruction,
  parseAgentSpec,
  parseDispatchMetadata,
  resolveRealtimeVoice,
  type DispatchMetadata,
} from './agent-runtime.js';
import { buildStandardSession } from './standard-pipeline.js';
import {
  createKnowledgeSearchClient,
  createKnowledgeTool,
  retrievalChunkLimit,
} from './knowledge-retrieval.js';
import { createGoogleTools, createToolInvokeClient } from './google-tools.js';
import { CallMeter, createRuntimeUsageClient, runWithMeteredCall } from './runtime-usage.js';
import { resolveCallAttribution } from './call-attribution.js';

const prisma = new PrismaClient();

/**
 * Builds the metering lifecycle for a dispatched job.
 *
 * Metering requires a call, an organization, and internal API credentials.
 * Inbound dispatches resolve their call from the SIP participant before this is
 * invoked; a missing identity therefore fails the job instead of running an
 * admitted call without runtime enforcement.
 */
function createCallMeter(ctx: JobContext, metadata: DispatchMetadata): CallMeter | null {
  const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (!metadata.callId || !metadata.organizationId) {
    throw new Error('[metering] callId and organizationId are required before a call can start.');
  }
  if (!apiBaseUrl || !internalApiKey) {
    throw new Error(
      '[metering] INTERNAL_API_BASE_URL/INTERNAL_API_KEY are required for attributed calls.',
    );
  }

  return new CallMeter({
    callId: metadata.callId,
    organizationId: metadata.organizationId,
    emit: createRuntimeUsageClient({ apiBaseUrl, internalApiKey }),
    ...(metadata.maxDurationSeconds !== undefined
      ? { maxDurationSeconds: metadata.maxDurationSeconds }
      : {}),
    // Hanging up is the only enforcement the runtime has: a refused minute must
    // end the call rather than merely stop being recorded.
    terminate: async (reason) => {
      console.warn(`[metering] terminating call ${metadata.callId} after billing decision: ${reason}`);
      await ctx.room.disconnect().catch(() => undefined);
      ctx.shutdown(`billing:${reason}`);
    },
  });
}

class VoiceForgeAgent extends voice.Agent {
  constructor(instructions: string, tools: llm.ToolContextEntry[]) {
    super({ instructions, tools });
  }
}

async function loadAgentSpec(metadata: DispatchMetadata): Promise<ReturnType<typeof parseAgentSpec>> {
  const agent = await prisma.agent.findUnique({
    where: { id: metadata.agentId },
    select: {
      id: true,
      workspaceId: true,
      specJson: true,
      activeVersionId: true,
    },
  });

  if (!agent) {
    throw new Error(`Agent ${metadata.agentId} was not found for dispatched LiveKit job.`);
  }

  if (agent.specJson) {
    return parseAgentSpec(agent.specJson);
  }

  if (agent.activeVersionId) {
    const version = await prisma.agentVersion.findUnique({
      where: { id: agent.activeVersionId },
      select: { specJson: true },
    });
    if (version?.specJson) {
      return parseAgentSpec(version.specJson);
    }
  }

  throw new Error(`Agent ${metadata.agentId} has no active Agent Spec JSON.`);
}

/** Key under which {@link prewarm} caches the loaded VAD on the job process. */
const VAD_USERDATA_KEY = 'vad';

export default defineAgent({
  // Loading the Silero ONNX model takes long enough to be audible if done once
  // per call, so it is loaded once per worker process and shared by every job
  // that process handles. Only the standard pipeline needs it — Realtime does
  // its own turn detection server-side — but prewarm cannot know which pipeline
  // the next job will use.
  prewarm: async (proc: JobProcess) => {
    try {
      proc.userData[VAD_USERDATA_KEY] = await silero.VAD.load();
    } catch (err) {
      // A failed prewarm must not take the worker down: Realtime calls do not
      // need VAD, and standard calls fail individually with a clear error.
      console.error('[prewarm] failed to load Silero VAD; standard-pipeline calls will fail.', err);
    }
  },
  entry: async (ctx: JobContext) => {
    const dispatchMetadata = parseDispatchMetadata(ctx.job.metadata);
    await ctx.connect();
    const participant = dispatchMetadata.callId ? null : await ctx.waitForParticipant();
    const metadata = await resolveCallAttribution(dispatchMetadata, participant, prisma.call);
    const meter = createCallMeter(ctx, metadata);
    try {
      await runCall(ctx, metadata, meter, ctx.proc.userData[VAD_USERDATA_KEY] as VAD | undefined);
    } catch (err) {
      // The call never became billable. Reporting the failure is what returns
      // the reserved minute and frees the concurrency slot immediately.
      await meter?.failed('runtime_error');
      throw err;
    }
  },
});

async function runCall(
  ctx: JobContext,
  metadata: DispatchMetadata,
  meter: CallMeter | null,
  vad: VAD | undefined,
): Promise<void> {
  const spec = await loadAgentSpec(metadata);
  const fallbackVoice = process.env.OPENAI_REALTIME_VOICE ?? 'marin';
  const tools: llm.ToolContextEntry[] = [];
  const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  // Attribution (entry) guarantees a call id before any session runs; the
  // internal knowledge and tool routes require it to bind the agent to the
  // admitted call's tenant, so a missing id fails here rather than as a 403
  // mid-conversation.
  const callId = metadata.callId;
  if (!callId) {
    throw new Error('[runtime] callId is required before knowledge or tools can be configured.');
  }
  if (retrievalChunkLimit(spec) > 0) {
    const search = apiBaseUrl && internalApiKey
      ? createKnowledgeSearchClient({ apiBaseUrl, internalApiKey })
      : async () => {
          throw new Error('Knowledge retrieval is not configured.');
        };
    const knowledgeTool = createKnowledgeTool({
      spec,
      agentId: metadata.agentId,
      callId,
      search,
    });
    if (knowledgeTool) tools.push(knowledgeTool);
  }

  // Google tools (Calendar, Gmail, Sheets) referenced by the Agent Spec are
  // callable during live calls through the internal tool-invocation endpoint.
  // Each wrapper contains its own failures, so a broken integration degrades
  // to a fallback message instead of crashing the call.
  if (spec.tools.length > 0) {
    if (apiBaseUrl && internalApiKey) {
      const invoke = createToolInvokeClient({
        apiBaseUrl,
        internalApiKey,
        agentId: metadata.agentId,
        callId,
      });
      tools.push(...createGoogleTools({ spec, invoke }));
    } else {
      // Silent tool loss is very hard to diagnose from a live call; make the
      // misconfiguration visible in the worker logs.
      console.warn(
        `[google-tools] agent ${metadata.agentId} references ${spec.tools.length} tool(s) ` +
          'but INTERNAL_API_BASE_URL / INTERNAL_API_KEY are not configured; tools disabled for this call.',
      );
    }
  }

  // The pipeline is a billing decision made by the API when the call was
  // created (free plans and half of starter calls run in-house), so it is read
  // from dispatch metadata rather than re-derived here.
  const session = metadata.pipeline === 'standard'
    ? buildStandardPipelineSession(spec, vad)
    : new voice.AgentSession({
        llm: new openai.realtime.RealtimeModel({
          voice: resolveRealtimeVoice(spec, fallbackVoice),
        }),
      });

  const startSession = async (): Promise<void> => {
    await session.start({
      agent: new VoiceForgeAgent(buildVoiceForgeInstructions(spec, metadata), tools),
      room: ctx.room,
    });
    await session.generateReply({
      instructions: firstReplyInstruction(spec),
    });
  };

  if (!meter) {
    await startSession();
    return;
  }

  // Billing authorization must precede AgentSession.start(): both Realtime and
  // standard sessions begin automatic turn handling as soon as they start.
  await runWithMeteredCall(
    meter,
    metadata.providerCallId ?? ctx.room.name ?? callId,
    (callback) => ctx.addShutdownCallback(callback),
    startSession,
  );
}

/**
 * Builds the in-house cascaded session, requiring the prewarmed VAD.
 *
 * Turn detection is not optional for a cascaded pipeline — without it the agent
 * cannot tell when the caller stopped talking — so a missing VAD fails the call
 * rather than starting one that can never take a turn.
 */
function buildStandardPipelineSession(
  spec: ReturnType<typeof parseAgentSpec>,
  vad: VAD | undefined,
): voice.AgentSession<llm.ToolContext> {
  if (!vad) {
    throw new Error(
      'The standard voice pipeline requires the prewarmed Silero VAD, which failed to load on this worker.',
    );
  }
  return buildStandardSession({ spec, vad });
}

const agentName = process.env.LIVEKIT_AGENT_NAME ?? 'voiceforge-agent';

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName,
}));
