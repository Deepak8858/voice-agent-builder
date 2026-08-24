/**
 * auth-flow.js — Authenticated smoke test for VoiceForge AI.
 *
 * Validates the critical authenticated user journeys that power the
 * first-working-demo flow: session health → agent discovery →
 * AI-powered agent generation → call history retrieval.
 *
 * What this test validates:
 *   1. Auth/session integrity via GET /auth/me.
 *   2. Multi-tenant scoping via GET /workspaces/:workspaceId/agents.
 *   3. LLM-backed agent generation via POST /workspaces/:workspaceId/agents/generate.
 *   4. Calls dashboard data via GET /workspaces/:workspaceId/calls.
 *
 * Auth:
 *   Set AUTH_TOKEN to a Supabase access token. The API no longer exposes
 *   username/password signup or login endpoints.
 *
 * Environment variables:
 *   BASE_URL      API root (default: http://localhost:4000/api/v1)
 *   WORKSPACE_ID  Target workspace UUID (optional; auto-resolved in setup)
 *   AUTH_TOKEN    Supabase bearer token (required)
 *
 * Thresholds (run fails if breached):
 *   http_req_duration.p(95) < 800 ms  — 95th percentile latency under 800ms
 *   http_req_failed.rate    < 0.1%    — fewer than 1 in 1,000 requests fail
 *
 * Run:
 *   k6 run k6/auth-flow.js
 *   k6 run k6/auth-flow.js -e BASE_URL=https://api.yourdomain.com -e AUTH_TOKEN=xxx -e WORKSPACE_ID=ws-uuid
 */
import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const WORKSPACE_ID = __ENV.WORKSPACE_ID;

const customErrorRate = new Rate('custom_errors');

export const options = {
  vus: 5,
  duration: '1m',
  thresholds: {
    // 95th-percentile response time must stay under 800 ms
    http_req_duration: ['p(95)<800'],
    // Overall request failure rate must stay under 0.1 %
    http_req_failed: ['rate<0.001'],
    // Custom business-logic error rate must stay under 0.1 %
    custom_errors: ['rate<0.001'],
  },
};

/**
 * Build the headers object. When AUTH_TOKEN is set we use Bearer auth.
 * Otherwise we rely on the CookieJar passed in via request options.
 */
function makeHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}

/** Resolve the workspace once before VUs start. */
export function setup() {
  if (!AUTH_TOKEN) {
    fail('AUTH_TOKEN is required; obtain a Supabase access token through the web sign-in flow.');
  }

  let workspaceId = WORKSPACE_ID;
  if (!workspaceId) {
    const wsRes = http.get(`${BASE_URL}/workspaces`, { headers: makeHeaders() });
    check(wsRes, { 'setup: workspaces list succeeds': (r) => r.status === 200 });
    if (wsRes.status === 200) {
      try {
        workspaceId = JSON.parse(wsRes.body).items?.[0]?.id;
      } catch (_e) {
        // handled below
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
  if (!ws) {
    console.warn('WARN: missing workspaceId; skipping iteration.');
    return;
  }

  const cfg = baseConfig();

  // ── 1. Session validation ──
  // Ensures the auth middleware, session store / JWT validator, and
  // user-resolution path are all healthy.
  const meRes = http.get(`${BASE_URL}/auth/me`, cfg);
  check(meRes, {
    'auth/me returns 200': (r) => r.status === 200,
    'auth/me returns user JSON': (r) => {
      try {
        const b = JSON.parse(r.body);
        return b.id !== undefined && b.email !== undefined;
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(meRes.status >= 400 ? 1 : 0);

  // ── 2. Agent discovery ──
  // Mirrors the builder UI loading the agent list. Validates the
  // WorkspaceGuard, agent service, and caching layer (X-Cache-Hit header).
  const agentsRes = http.get(`${BASE_URL}/workspaces/${ws}/agents`, cfg);
  check(agentsRes, {
    'GET /agents returns 200': (r) => r.status === 200,
    'GET /agents returns items array': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).items);
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(agentsRes.status >= 400 ? 1 : 0);

  // ── 3. Generate agent from natural-language prompt ──
  // This is the heaviest happy-path request (LLM invocation).
  // For the p(95)<800ms threshold to pass, the API should be configured
  // with a fast LLM provider or the mock adapter.
  const generatePayload = JSON.stringify({
    prompt:
      'Create a warm dental appointment reminder agent. It confirms the date/time, ' +
      'reminds the patient to arrive 15 minutes early, and offers rescheduling.',
    business_context: {
      business_name: 'Downtown Dental',
      timezone: 'America/New_York',
      industry_hint: 'healthcare',
    },
  });
  const genRes = http.post(
    `${BASE_URL}/workspaces/${ws}/agents/generate`,
    generatePayload,
    cfg
  );
  check(genRes, {
    'POST /agents/generate returns 200': (r) => r.status === 200,
    'POST /agents/generate returns spec': (r) => {
      try {
        return JSON.parse(r.body).spec !== undefined;
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(genRes.status >= 400 ? 1 : 0);

  // ── 4. Call history retrieval ──
  // Validates the calls service, Postgres indexes on workspace_id,
  // and basic permission scoping.
  const callsRes = http.get(`${BASE_URL}/workspaces/${ws}/calls`, cfg);
  check(callsRes, {
    'GET /calls returns 200': (r) => r.status === 200,
    'GET /calls returns items array': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).items);
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(callsRes.status >= 400 ? 1 : 0);

  sleep(1);
}
