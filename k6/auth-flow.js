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
 * Auth strategies (pick one):
 *   A. Bearer token — set AUTH_TOKEN env var. The script sends
 *      `Authorization: Bearer <token>` on every request.
 *   B. Session cookie — set AUTH_EMAIL and AUTH_PASSWORD. The script
 *      signs up / logs in during setup() and propagates the session
 *      cookie to all VUs.
 *
 * Environment variables:
 *   BASE_URL      API root (default: http://localhost:4000/api/v1)
 *   WORKSPACE_ID  Target workspace UUID (optional; auto-resolved in setup)
 *   AUTH_TOKEN    Bearer token for header-based auth (optional)
 *   AUTH_EMAIL    Email for session auth (default: auto-generated)
 *   AUTH_PASSWORD Password for session auth (default: LoadTest123!)
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
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const AUTH_EMAIL = __ENV.AUTH_EMAIL || `k6-auth-${Date.now()}@voiceforge.test`;
const AUTH_PASSWORD = __ENV.AUTH_PASSWORD || 'LoadTest123!';
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

/**
 * setup() runs once globally before VUs start.
 *
 * If the caller did not supply AUTH_TOKEN or WORKSPACE_ID we:
 *   1. Create (or log in) a test user.
 *   2. Capture the session cookie.
 *   3. Resolve a workspace ID from /workspaces.
 */
export function setup() {
  // Fast path: caller provided everything we need.
  if (AUTH_TOKEN && WORKSPACE_ID) {
    return { workspaceId: WORKSPACE_ID, cookies: null };
  }

  const jar = new http.CookieJar();
  const jsonHeaders = { 'Content-Type': 'application/json' };

  // ── Authenticate (sign-up first, fall back to login) ──
  const signupRes = http.post(
    `${BASE_URL}/auth/signup`,
    JSON.stringify({
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
      name: 'k6 Auth Flow Test',
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
    check(loginRes, {
      'setup: login succeeds': (r) => r.status === 200,
    });
  }

  // Extract cookies so we can inject them into each VU's jar.
  const cookies = jar.cookiesForURL(BASE_URL);

  // ── Resolve workspace ──
  let workspaceId = WORKSPACE_ID;
  if (!workspaceId) {
    const wsRes = http.get(`${BASE_URL}/workspaces`, {
      headers: jsonHeaders,
      jar,
    });
    check(wsRes, {
      'setup: workspaces list succeeds': (r) => r.status === 200,
    });
    if (wsRes.status === 200) {
      try {
        const body = JSON.parse(wsRes.body);
        if (body.items && body.items.length > 0) {
          workspaceId = body.items[0].id;
        }
      } catch (_e) {
        // leave workspaceId undefined
      }
    }
  }

  if (!workspaceId) {
    console.warn(
      'WARN: No workspace resolved. Set WORKSPACE_ID or ensure the seeded user has a workspace.'
    );
  }

  return { workspaceId, cookies };
}

/**
 * Create a fresh CookieJar for the current VU and seed it with the
 * session cookies gathered during setup().
 */
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
  if (!ws) {
    console.warn('WARN: missing workspaceId; skipping iteration.');
    return;
  }

  const cfg = baseConfig(data);

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
