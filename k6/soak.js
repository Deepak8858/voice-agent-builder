/**
 * soak.js — Soak test for VoiceForge AI.
 *
 * Runs a modest, steady load (10 VUs) for 30 minutes. Soak tests are
 * designed to catch resource leaks, gradual performance degradation,
 * connection-pool exhaustion, and cache-tier saturation that only
 * appear after sustained traffic.
 *
 * Endpoints exercised:
 *   GET  /health                          — dependency liveness
 *   GET  /workspaces/:workspaceId/agents  — list + cache layer
 *   GET  /workspaces/:workspaceId/agents/:agentId — single-agent fetch
 *
 * Auth:
 *   Set AUTH_TOKEN to a Supabase access token. The suite fails before load
 *   starts when it is missing.
 *
 * Environment variables:
 *   BASE_URL      API root (default: http://localhost:4000/api/v1)
 *   WORKSPACE_ID  Target workspace UUID (optional; resolved in setup)
 *   AGENT_ID      Specific agent UUID to fetch (optional; first agent used otherwise)
 *   AUTH_TOKEN    Supabase bearer token (required)
 *
 * Thresholds:
 *   http_req_duration.p(95) < 1 s  — 95th-percentile latency under 1 second
 *   http_req_failed.rate    < 0.5% — fewer than 0.5 % requests may fail
 *
 * Run:
 *   k6 run k6/soak.js
 *   k6 run k6/soak.js -e BASE_URL=https://api.yourdomain.com -e AUTH_TOKEN=xxx
 */
import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { apiData, apiItems } from './lib/api-response.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const WORKSPACE_ID = __ENV.WORKSPACE_ID;
const AGENT_ID = __ENV.AGENT_ID;

const customErrorRate = new Rate('custom_errors');
const agentFetchLatency = new Trend('agent_fetch_latency');

export const options = {
  stages: [
    { duration: '2m', target: 10 },   // gentle ramp to 10 VUs
    { duration: '26m', target: 10 },  // steady state for 26 minutes
    { duration: '2m', target: 0 },    // gentle ramp-down
  ],
  thresholds: {
    // 95th-percentile latency must remain under 1 second for the entire run.
    http_req_duration: ['p(95)<1000'],
    // Fewer than 0.5 % of requests may fail.
    http_req_failed: ['rate<0.005'],
    custom_errors: ['rate<0.005'],
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
  let agentId = AGENT_ID;

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

  if (workspaceId && !agentId) {
    const agentsRes = http.get(
      `${BASE_URL}/workspaces/${workspaceId}/agents`,
      { headers: jsonHeaders }
    );
    if (agentsRes.status === 200) {
      const items = apiItems(agentsRes);
      if (items && items.length > 0) {
        agentId = items[0].id;
      }
    }
  }

  if (!workspaceId) {
    fail('WORKSPACE_ID was not supplied and no workspace could be resolved for AUTH_TOKEN.');
  }
  // Fail closed for the same reason as the workspace check above: an
  // unresolved agent leaves `data.agentId` undefined, the single-agent fetch is
  // skipped for the whole 30-minute run, and the soak silently exercises only
  // half the endpoints it claims to cover.
  if (!agentId) {
    fail('AGENT_ID was not supplied and no agent could be resolved in the workspace.');
  }

  return { workspaceId, agentId, cookies: null };
}

function baseConfig() {
  return { headers: makeHeaders() };
}

export default function (data) {
  const ws = data.workspaceId || WORKSPACE_ID;
  const agentId = data.agentId || AGENT_ID;
  const cfg = baseConfig();

  // ── 1. Health probe ──
  // Repeated every iteration for 30 minutes: any DB connection leak or
  // Redis timeout will eventually surface here.
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health returns 200': (r) => r.status === 200,
    'health db still ok': (r) => apiData(r)?.checks?.db === 'ok',
    'health redis still ok': (r) => apiData(r)?.checks?.redis === 'ok',
  });
  customErrorRate.add(healthRes.status >= 400 ? 1 : 0);

  if (!ws) {
    sleep(2);
    return;
  }

  // ── 2. Agents list ──
  // Sustained reads against the agent cache / DB index.
  const agentsRes = http.get(`${BASE_URL}/workspaces/${ws}/agents`, cfg);
  check(agentsRes, {
    'GET agents returns 200': (r) => r.status === 200,
    'GET agents returns items': (r) => apiItems(r) !== null,
  });
  customErrorRate.add(agentsRes.status >= 400 ? 1 : 0);

  // ── 3. Single-agent fetch ──
  // Validates row-level retrieval, serialization of the full AgentDetail
  // (including versions and active_spec), and any N+1 query patterns.
  if (agentId) {
    const start = Date.now();
    const agentRes = http.get(
      `${BASE_URL}/workspaces/${ws}/agents/${agentId}`,
      cfg
    );
    agentFetchLatency.add(Date.now() - start);
    check(agentRes, {
      'GET agent by id returns 200': (r) => r.status === 200,
      'GET agent by id returns agent JSON': (r) => {
        const b = apiData(r);
        return b !== null && b.id !== undefined && b.name !== undefined;
      },
    });
    customErrorRate.add(agentRes.status >= 400 ? 1 : 0);
  }

  sleep(2);
}
