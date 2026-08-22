import {
  ServerOptions,
  cli,
  defineAgent,
  voice,
  type llm,
  type JobContext,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
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
import {
  createKnowledgeSearchClient,
  createKnowledgeTool,
  retrievalChunkLimit,
} from './knowledge-retrieval.js';
import { createGoogleTools, createToolInvokeClient } from './google-tools.js';
import { CallMeter, createRuntimeUsageClient } from './runtime-usage.js';
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

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const dispatchMetadata = parseDispatchMetadata(ctx.job.metadata);
    await ctx.connect();
    const participant = dispatchMetadata.callId ? null : await ctx.waitForParticipant();
    const metadata = await resolveCallAttribution(dispatchMetadata, participant, prisma.call);
    const meter = createCallMeter(ctx, metadata);
    try {
      await runCall(ctx, metadata, meter);
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
): Promise<void> {
  const spec = await loadAgentSpec(metadata);
  const fallbackVoice = process.env.OPENAI_REALTIME_VOICE ?? 'marin';
  const tools: llm.ToolContextEntry[] = [];
  const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (retrievalChunkLimit(spec) > 0) {
    const search = apiBaseUrl && internalApiKey
      ? createKnowledgeSearchClient({ apiBaseUrl, internalApiKey })
      : async () => {
          throw new Error('Knowledge retrieval is not configured.');
        };
    const knowledgeTool = createKnowledgeTool({
      spec,
      agentId: metadata.agentId,
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
        ...(metadata.callId ? { callId: metadata.callId } : {}),
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

  const session = new voice.AgentSession({
    llm: new openai.realtime.RealtimeModel({
      voice: resolveRealtimeVoice(spec, fallbackVoice),
    }),
  });

  await session.start({
    agent: new VoiceForgeAgent(buildVoiceForgeInstructions(spec, metadata), tools),
    room: ctx.room,
  });

  if (meter) {
    // Registered before the first reply so a crash mid-conversation still
    // settles the call instead of leaking its reservation and lease.
    ctx.addShutdownCallback(async () => {
      await meter.ended();
    });
    // Inbound attribution preserves Twilio's CallSid. Outbound calls already
    // carry their provider identity in dispatch metadata when available.
    await meter.connected(metadata.providerCallId ?? ctx.room.name ?? (metadata.callId as string));
    if (meter.isSettled) return;
    meter.start();
  }

  await session.generateReply({
    instructions: firstReplyInstruction(spec),
  });
}

const agentName = process.env.LIVEKIT_AGENT_NAME ?? 'voiceforge-agent';

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName,
}));
