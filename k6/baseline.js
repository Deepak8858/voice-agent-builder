/**
 * k6 baseline test — steady-state load for 2 minutes.
 *
 * Simulates normal production traffic: ~10 users, 5 req/s average,
 * 95th-percentile response time should stay under 500 ms.
 *
 * Run:
 *   k6 run k6/baseline.js
 *   k6 run k6/baseline.js -e BASE_URL=https://api.yourdomain.com
 *
 * Thresholds (fail the run if breached):
 *   http_req_duration.p95 < 500ms
 *   http_req_failed < 1%
 *   http_reqs > 300 (ensure we actually ran load)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:4000/api/v1';

export const options = {
  duration: '2m',
  vus: 10,
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    http_reqs: ['count>300'],
  },
};

const errorRate = new Rate('errors');

export default function () {
  // Health endpoint — lightweight, high-frequency
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health status 200': (r) => r.status === 200,
    'health has db field': (r) => JSON.parse(r.body).db !== undefined,
  });
  errorRate.add(healthRes.status !== 200 ? 1 : 0);

  // Simulate a real API call (agents list — unauthenticated for load test)
  const agentsRes = http.get(`${BASE_URL}/agents`);
  check(agentsRes, {
    'agents status 200 or 401': (r) => r.status === 200 || r.status === 401,
  });
  errorRate.add(agentsRes.status >= 400 && agentsRes.status !== 401 ? 1 : 0);

  sleep(2);
}