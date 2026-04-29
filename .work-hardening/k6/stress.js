/**
 * k6 stress test — ramp to 50 VUs over 1 min, hold 1 min, ramp down.
 *
 * Identifies the breaking point: max sustainable RPS, connection pool
 * exhaustion, slow DB queries that only surface under load.
 *
 * Run:
 *   k6 run k6/stress.js
 *   k6 run k6/stress.js -e BASE_URL=https://api.yourdomain.com
 *
 * Thresholds (warnings only — do not fail the run):
 *   http_req_duration.p99 < 2s
 *   http_req_failed < 5%
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:4000/api/v1';

export const options = {
  stages: [
    { duration: '1m', target: 50 },  // ramp up
    { duration: '1m', target: 50 },  // hold
    { duration: '30s', target: 0 },  // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(99)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

const errorRate = new Rate('errors');

export default function () {
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, { 'health ok': (r) => r.status === 200 });
  errorRate.add(healthRes.status !== 200 ? 1 : 0);

  // Agents list (load test)
  const agentsRes = http.get(`${BASE_URL}/agents`);
  check(agentsRes, { 'agents ok': (r) => r.status < 500 });
  errorRate.add(agentsRes.status >= 500 ? 1 : 0);

  // Simulate POST workload (create tool invocation — no auth for stress test)
  const payload = JSON.stringify({
    name: 'test_tool',
    tool_type: 'webhook',
    config: {
      url: 'https://example.com/hook',
      method: 'POST',
      timeout_ms: 5000,
    },
    input_schema: { type: 'object', properties: {}, required: [] },
  });
  const postRes = http.post(`${BASE_URL}/tools`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  check(postRes, { 'post ok or 4xx': (r) => r.status < 500 });
  errorRate.add(postRes.status >= 500 ? 1 : 0);

  sleep(1);
}
