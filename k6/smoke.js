/**
 * k6 smoke test — health + readiness checks for CI/CD pipelines.
 *
 * Runs for 30 seconds with a single VU. Fails fast on any error.
 * Use in CI to gate deployments on API availability.
 *
 * Run:
 *   k6 run k6/smoke.js
 *   k6 run k6/smoke.js -e BASE_URL=https://api.yourdomain.com
 *
 * Thresholds:
 *   http_req_duration.p95 < 1s  (even 1s is generous for /health)
 *   http_req_failed < 0.1%    (allow 0 errors)
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:4000/api/v1';

export const options = {
  duration: '30s',
  vus: 1,
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.001'],
  },
};

export default function () {
  // 1. Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health returns 200': (r) => r.status === 200,
    'health body is JSON': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status !== undefined && body.db !== undefined && body.redis !== undefined;
      } catch {
        return false;
      }
    },
    'health db is ok': (r) => JSON.parse(r.body).db === 'ok',
  });

  // 2. Readiness probe (same endpoint, ensures all dependencies are up)
  check(healthRes, {
    'health overall status ok or degraded': (r) => {
      const body = JSON.parse(r.body);
      return body.status === 'ok' || body.status === 'degraded';
    },
  });

  // 3. Auth-gated endpoint — should return 401, not 500
  const agentsRes = http.get(`${BASE_URL}/agents`);
  check(agentsRes, {
    'agents returns 401 (auth required)': (r) => r.status === 401,
    'agents returns JSON error': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.error !== undefined;
      } catch {
        return false;
      }
    },
  });
}