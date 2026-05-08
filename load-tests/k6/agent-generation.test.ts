// load-tests/k6/agent-generation.test.ts
// Load tests for LLM agent generation endpoints

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { BASE_URL, authHeaders, agentThresholds } from './common';

export const options = {
  stages: [
    { duration: '1m', target: 5 },     // Warm up with 5 VUs
    { duration: '2m', target: 20 },     // Ramp to 20 VUs for LLM stress
    { duration: '2m', target: 20 },    // Sustained load
    { duration: '30s', target: 0 },    // Cool down
  ],
  thresholds: agentThresholds,
};

// Sample agent creation payload
const createAgentPayload = JSON.stringify({
  name: `LoadTestAgent_${__VU}_${__ITER}`,
  description: 'Load test agent for performance testing',
  systemPrompt: 'You are a helpful assistant designed for load testing.',
  model: 'claude-sonnet-4-20250514',
  maxTokens: 1024,
});

// Sample generation request payload
const generationPayload = JSON.stringify({
  messages: [
    { role: 'user', content: 'Hello, this is a load test message.' }
  ],
  maxTokens: 512,
});

export default function () {
  group('Agent Creation Performance', () => {
    const createRes = http.post(
      `${BASE_URL}/agents`,
      createAgentPayload,
      { headers: authHeaders() }
    );

    check(createRes, {
      'agent creation succeeded': (r) => r.status === 200 || r.status === 201,
      'agent creation < 5s': (r) => r.timings.duration < 5000,
    });

    // Parse response for agent ID
    let agentId = null;
    try {
      const body = JSON.parse(createRes.body);
      agentId = body.id || body.data?.id;
    } catch (e) {
      // Continue without agent ID
    }

    // If we got an agent ID, test message generation
    if (agentId) {
      group('Agent Generation Performance', () => {
        const genRes = http.post(
          `${BASE_URL}/agents/${agentId}/generate`,
          generationPayload,
          { headers: authHeaders() }
        );

        check(genRes, {
          'generation succeeded': (r) => r.status === 200,
          'generation < 10s': (r) => r.timings.duration < 10000,
        });
      });

      // Clean up - delete test agent
      http.del(`${BASE_URL}/agents/${agentId}`, null, {
        headers: authHeaders(),
      });
    }
  });

  sleep(2);  // Longer sleep for rate limiting
}