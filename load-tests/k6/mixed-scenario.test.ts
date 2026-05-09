// load-tests/k6/mixed-scenario.test.ts
// Realistic mixed workload simulation

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { BASE_URL, authHeaders } from './common';

export const options = {
  stages: [
    { duration: '1m', target: 30 },    // Normal load ramp
    { duration: '3m', target: 100 },   // Peak sustained load
    { duration: '1m', target: 30 },   // Cool down to normal
    { duration: '30s', target: 0 },   // Final cool down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'],  // 3s p95 for mixed
    http_req_failed: ['rate<0.02'],      // <2% error rate
  },
};

// Helper to pick random item from array
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Simulate different user workflows
const workflows = ['browse', 'create', 'query', 'call'];  // 25% each

export default function () {
  const workflow = randomItem(workflows);

  switch (workflow) {
    case 'browse':
      group('Browse Agents', () => {
        const res = http.get(`${BASE_URL}/agents`, {
          headers: authHeaders(),
        });
        check(res, {
          'list agents succeeded': (r) => r.status === 200,
          'list < 1s': (r) => r.timings.duration < 1000,
        });
      });
      break;

    case 'create':
      group('Create Agent + Generate', () => {
        const createPayload = JSON.stringify({
          name: `MixedTest_${__VU}_${__ITER}`,
          description: 'Mixed load test agent',
          systemPrompt: 'You are a helpful assistant.',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 512,
        });

        const createRes = http.post(`${BASE_URL}/agents`, createPayload, {
          headers: authHeaders(),
        });

        check(createRes, {
          'create succeeded': (r) => r.status === 200 || r.status === 201,
          'create < 3s': (r) => r.timings.duration < 3000,
        });

        let agentId = null;
        try {
          const body = JSON.parse(createRes.body);
          agentId = body.id || body.data?.id;
        } catch (e) { /* continue */ }

        if (agentId) {
          // Generate content
          const genRes = http.post(
            `${BASE_URL}/agents/${agentId}/generate`,
            JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: 100 }),
            { headers: authHeaders() }
          );

          check(genRes, {
            'generate succeeded': (r) => r.status === 200,
            'generate < 8s': (r) => r.timings.duration < 8000,
          });

          // Cleanup
          http.del(`${BASE_URL}/agents/${agentId}`, null, {
            headers: authHeaders(),
          });
        }
      });
      break;

    case 'query':
      group('Knowledge Query', () => {
        const queryRes = http.post(
          `${BASE_URL}/knowledge/query`,
          JSON.stringify({ query: 'test query', topK: 3 }),
          { headers: authHeaders() }
        );

        check(queryRes, {
          'query succeeded': (r) => r.status === 200,
          'query < 2s': (r) => r.timings.duration < 2000,
        });
      });
      break;

    case 'call':
      group('Webhook Call Event', () => {
        const eventRes = http.post(
          `${BASE_URL}/webhooks/call-events`,
          JSON.stringify({
            eventType: 'call_ended',
            callId: `mixed_${__VU}_${__ITER}`,
            timestamp: new Date().toISOString(),
            duration: 120,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );

        check(eventRes, {
          'event accepted': (r) => r.status >= 200 && r.status < 300,
          'event < 500ms': (r) => r.timings.duration < 500,
        });
      });
      break;
  }

  sleep(Math.random() * 2 + 0.5);  // Random think time 0.5-2.5s
}