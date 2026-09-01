#!/usr/bin/env node
/**
 * Live-connectivity probe for the in-house "standard" voice pipeline: Azure
 * Speech, the Azure OpenAI voice-brain deployment, and LiveKit. Run on the host
 * against the production env file:
 *
 *   node --env-file=/opt/voiceforge/.env scripts/azure-voice-probe.mjs
 *
 * Prints PASS/FAIL/SKIP per check and never prints key material. Exits 1 on
 * any failure; a SKIP (missing variable) is also a failure when
 * VOICE_STANDARD_PIPELINE_ENABLED is on, because the worker will refuse to boot.
 */

import { createHmac } from 'node:crypto';

// Matches DEFAULT_AZURE_OPENAI_API_VERSION in apps/livekit-agent/src/standard-pipeline.ts.
const DEFAULT_AZURE_OPENAI_API_VERSION = '2024-10-21';

const env = (name) => process.env[name]?.trim() || undefined;

function livekitToken(apiKey, apiSecret) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ iss: apiKey, video: { roomList: true }, exp: now + 300, nbf: now - 10 });
  const signature = createHmac('sha256', apiSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Runs one check; returns 'pass' | 'fail' | 'skip'. */
async function probe(name, vars, request) {
  const absent = vars.filter((v) => !env(v));
  if (absent.length > 0) {
    console.log(`SKIP ${name}: ${absent.join(', ')} not set`);
    return 'skip';
  }
  try {
    const res = await request();
    if (res.status === 200) {
      console.log(`PASS ${name}`);
      return 'pass';
    }
    console.log(`FAIL ${name}: HTTP ${res.status}`);
    return 'fail';
  } catch (err) {
    console.log(`FAIL ${name}: ${err?.cause?.code ?? err?.message ?? err}`);
    return 'fail';
  }
}

const outcomes = [];

outcomes.push(
  await probe('Azure Speech', ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'], () =>
    fetch(
      `https://${env('AZURE_SPEECH_REGION')}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': env('AZURE_SPEECH_KEY') },
      },
    ),
  ),
);

outcomes.push(
  await probe(
    'Azure OpenAI',
    ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_VOICE_LLM_DEPLOYMENT'],
    () => {
      const endpoint = env('AZURE_OPENAI_ENDPOINT').replace(/\/+$/, '');
      const apiVersion = env('AZURE_OPENAI_API_VERSION') ?? DEFAULT_AZURE_OPENAI_API_VERSION;
      const deployment = env('AZURE_VOICE_LLM_DEPLOYMENT');
      return fetch(
        `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
        {
          method: 'POST',
          headers: { 'api-key': env('AZURE_OPENAI_API_KEY'), 'Content-Type': 'application/json' },
          // max_completion_tokens: newer model generations (gpt-5.x) reject the
          // legacy max_tokens parameter with HTTP 400.
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'ping' }],
            max_completion_tokens: 16,
          }),
        },
      );
    },
  ),
);

outcomes.push(
  await probe('LiveKit', ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'], () =>
    fetch(
      `${env('LIVEKIT_URL').replace(/^wss:\/\//, 'https://')}/twirp/livekit.RoomService/ListRooms`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${livekitToken(env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'))}`,
        },
        body: '{}',
      },
    ),
  ),
);

const pipelineEnabled = /^(1|true|yes|on)$/i.test(process.env.VOICE_STANDARD_PIPELINE_ENABLED ?? '');
const failed = outcomes.some(
  (outcome) => outcome === 'fail' || (outcome === 'skip' && pipelineEnabled),
);
process.exit(failed ? 1 : 0);
