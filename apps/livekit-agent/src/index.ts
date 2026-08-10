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

const prisma = new PrismaClient();

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
    const metadata = parseDispatchMetadata(ctx.job.metadata);
    const spec = await loadAgentSpec(metadata);
    const fallbackVoice = process.env.OPENAI_REALTIME_VOICE ?? 'marin';
    const tools: llm.ToolContextEntry[] = [];
    if (retrievalChunkLimit(spec) > 0) {
      const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
      const internalApiKey = process.env.INTERNAL_API_KEY;
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

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        voice: resolveRealtimeVoice(spec, fallbackVoice),
      }),
    });

    await session.start({
      agent: new VoiceForgeAgent(buildVoiceForgeInstructions(spec, metadata), tools),
      room: ctx.room,
    });

    await ctx.connect();
    await session.generateReply({
      instructions: firstReplyInstruction(spec),
    });
  },
});

const agentName = process.env.LIVEKIT_AGENT_NAME ?? 'voiceforge-agent';

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName,
}));
