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
 *   Set AUTH_TOKEN for Bearer auth, or AUTH_EMAIL + AUTH_PASSWORD for
 *   session-cookie auth. Without auth the workspace-scoped endpoints
 *   will return 401 and the threshold will breach.
 *
 * Environment variables:
 *   BASE_URL      API root (default: http://localhost:4000/api/v1)
 *   WORKSPACE_ID  Target workspace UUID (optional; resolved in setup)
 *   AGENT_ID      Specific agent UUID to fetch (optional; first agent used otherwise)
 *   AUTH_TOKEN    Bearer token (optional)
 *   AUTH_EMAIL    Session auth email (optional)
 *   AUTH_PASSWORD Session auth password (optional)
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
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const AUTH_EMAIL = __ENV.AUTH_EMAIL || `k6-soak-${Date.now()}@voiceforge.test`;
const AUTH_PASSWORD = __ENV.AUTH_PASSWORD || 'LoadTest123!';
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
  if (AUTH_TOKEN && WORKSPACE_ID) {
    return { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, cookies: null };
  }

  const jar = new http.CookieJar();
  const jsonHeaders = { 'Content-Type': 'application/json' };

  const signupRes = http.post(
    `${BASE_URL}/auth/signup`,
    JSON.stringify({
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
      name: 'k6 Soak Test',
      organization_name: 'k6 Test Org',
    }),
    { headers: jsonHeaders, jar }
  );

  if (signupRes.status !== 200 && signupRes.status !== 201) {
    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email: AUTH_EMAIL, password: AUTH_PASSWORD }),
      { headers: jsonHeaders, jar }
    );
    check(loginRes, { 'setup: login ok': (r) => r.status === 200 });
  }

  const cookies = jar.cookiesForURL(BASE_URL);
  let workspaceId = WORKSPACE_ID;
  let agentId = AGENT_ID;

  if (!workspaceId) {
    const wsRes = http.get(`${BASE_URL}/workspaces`, {
      headers: jsonHeaders,
      jar,
    });
    if (wsRes.status === 200) {
      try {
        const body = JSON.parse(wsRes.body);
        if (body.items && body.items.length > 0) {
          workspaceId = body.items[0].id;
        }
      } catch (_e) {
        /* ignore */
      }
    }
  }

  if (workspaceId && !agentId) {
    const agentsRes = http.get(
      `${BASE_URL}/workspaces/${workspaceId}/agents`,
      { headers: jsonHeaders, jar }
    );
    if (agentsRes.status === 200) {
      try {
        const body = JSON.parse(agentsRes.body);
        if (body.items && body.items.length > 0) {
          agentId = body.items[0].id;
        }
      } catch (_e) {
        /* ignore */
      }
    }
  }

  return { workspaceId, agentId, cookies };
}

function buildJar(data) {
  if (AUTH_TOKEN) return undefined;
  const jar = new http.CookieJar();
  if (data && data.cookies) {
    for (const name of Object.keys(data.cookies)) {
      for (const value of data.cookies[name]) {
        jar.set(BASE_URL, name, value);
      }
    }
  }
  return jar;
}

function baseConfig(data) {
  const jar = buildJar(data);
  const cfg = { headers: makeHeaders() };
  if (jar) cfg.jar = jar;
  return cfg;
}

export default function (data) {
  const ws = data.workspaceId || WORKSPACE_ID;
  const agentId = data.agentId || AGENT_ID;
  const cfg = baseConfig(data);

  // ── 1. Health probe ──
  // Repeated every iteration for 30 minutes: any DB connection leak or
  // Redis timeout will eventually surface here.
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health returns 200': (r) => r.status === 200,
    'health db still ok': (r) => {
      try {
        return JSON.parse(r.body).db === 'ok';
      } catch {
        return false;
      }
    },
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
    'GET agents returns items': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).items);
      } catch {
        return false;
      }
    },
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
        try {
          const b = JSON.parse(r.body);
          return b.id !== undefined && b.name !== undefined;
        } catch {
          return false;
        }
      },
    });
    customErrorRate.add(agentRes.status >= 400 ? 1 : 0);
  }

  sleep(2);
}
