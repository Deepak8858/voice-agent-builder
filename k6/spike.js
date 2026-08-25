/**
 * spike.js — Spike test for VoiceForge AI.
 *
 * Simulates a sudden traffic surge: 0 → 100 VUs in 10 seconds, held for
 * 30 seconds, then dropped to 0. This profile reveals:
 *   • Cold-start / connection-pool behaviour under burst load
 *   • Auto-scaling lag (if deployed on container platforms)
 *   • DB connection exhaustion or queue saturation
 *   • Whether the ingress / rate-limit layer blocks legitimate traffic
 *
 * Endpoints exercised:
 *   GET /health       — dependency health (DB, Redis, LLM provider ping)
 *   GET /workspaces/:workspaceId/agents — authenticated list (WorkspaceGuard)
 *
 * Auth:
 *   Set AUTH_TOKEN to a Supabase access token. The suite fails before load
 *   starts when it is missing.
 *
 * Environment variables:
 *   BASE_URL      API root (default: http://localhost:4000/api/v1)
 *   WORKSPACE_ID  Target workspace UUID (optional; resolved in setup)
 *   AUTH_TOKEN    Supabase bearer token (required)
 *
 * Threshold:
 *   http_req_failed.rate < 2%  — fewer than 2 % of requests may fail.
 *   Even under extreme burst, infrastructure errors (5xx, timeouts,
 *   connection resets) must stay minimal.
 *
 * Run:
 *   k6 run k6/spike.js
 *   k6 run k6/spike.js -e BASE_URL=https://api.yourdomain.com -e AUTH_TOKEN=xxx
 */
import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Rate } from 'k6/metrics';
import { apiData, apiItems } from './lib/api-response.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const WORKSPACE_ID = __ENV.WORKSPACE_ID;

const customErrorRate = new Rate('custom_errors');

export const options = {
  stages: [
    { duration: '10s', target: 100 }, // 0 → 100 VUs in 10 s (spike)
    { duration: '30s', target: 100 }, // hold peak for 30 s
    { duration: '5s', target: 0 },    // rapid ramp-down
  ],
  thresholds: {
    // Fail the run if > 2 % of requests fail (4xx/5xx/timeouts).
    http_req_failed: ['rate<0.02'],
    // Track custom business-logic failures separately.
    custom_errors: ['rate<0.02'],
  },
};

function makeHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}

export function setup() {
  if (!AUTH_TOKEN) {
    fail('AUTH_TOKEN is required; obtain a Supabase access token through the web sign-in flow.');
  }

  const jsonHeaders = makeHeaders();
  let workspaceId = WORKSPACE_ID;

  if (!workspaceId) {
    const wsRes = http.get(`${BASE_URL}/workspaces`, {
      headers: jsonHeaders,
    });
    if (wsRes.status === 200) {
      const items = apiItems(wsRes);
      if (items && items.length > 0) {
        workspaceId = items[0].id;
      }
    }
  }

  if (!workspaceId) {
    fail('WORKSPACE_ID was not supplied and no workspace could be resolved for AUTH_TOKEN.');
  }

  return { workspaceId, cookies: null };
}

function baseConfig() {
  return { headers: makeHeaders() };
}

export default function (data) {
  const ws = data.workspaceId || WORKSPACE_ID;
  const cfg = baseConfig();

  // ── 1. Health endpoint ──
  // Lightweight, no auth. Validates DB, Redis/Valkey, and LLM reachability.
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health returns 200': (r) => r.status === 200,
    'health body is JSON': (r) => {
      const b = apiData(r);
      return (
        b !== null &&
        b.status !== undefined &&
        b.checks?.db !== undefined &&
        b.checks?.redis !== undefined
      );
    },
    'health db is ok': (r) => apiData(r)?.checks?.db === 'ok',
  });
  customErrorRate.add(healthRes.status >= 400 ? 1 : 0);

  // ── 2. Authenticated agents list ──
  // This endpoint crosses auth middleware, workspace guard, service layer,
  // and optional response caching. Under spike load it is the best
  // proxy for general API capacity.
  if (ws) {
    const agentsRes = http.get(`${BASE_URL}/workspaces/${ws}/agents`, cfg);
    check(agentsRes, {
      'agents returns 200': (r) => r.status === 200,
      'agents does not 5xx': (r) => r.status < 500,
    });
    customErrorRate.add(agentsRes.status >= 400 ? 1 : 0);
  }

  sleep(0.5);
}
