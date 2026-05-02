/**
 * compliance-load.js — Load test for compliance-heavy workflows.
 *
 * VoiceForge AI cannot place an outbound call without passing the
 * compliance engine. This script simulates a realistic compliance
 * operations workflow:
 *
 *   1. List existing contacts and DNC entries (discovery).
 *   2. Upsert a new contact (unique phone per VU/iteration).
 *   3. Retrieve the contact to confirm creation.
 *   4. Update contact metadata.
 *   5. Grant explicit consent (outbound_marketing via API).
 *   6. Run a compliance check (should PASS with consent on file).
 *   7. Add a DNC entry (different phone, simulating an opt-out).
 *   8. List contacts again (verify eventual consistency / index health).
 *
 * Endpoints exercised:
 *   GET    /workspaces/:workspaceId/contacts
 *   POST   /workspaces/:workspaceId/contacts
 *   GET    /workspaces/:workspaceId/contacts/:contactId
 *   PATCH  /workspaces/:workspaceId/contacts/:contactId
 *   POST   /workspaces/:workspaceId/contacts/:contactId/consent
 *   POST   /workspaces/:workspaceId/compliance/check
 *   POST   /workspaces/:workspaceId/compliance/dnc
 *   GET    /workspaces/:workspaceId/compliance/dnc
 *
 * Auth:
 *   Set AUTH_TOKEN for Bearer auth, or AUTH_EMAIL + AUTH_PASSWORD for
 *   session-cookie auth. Without auth the workspace-scoped endpoints
 *   will return 401.
 *
 * Environment variables:
 *   BASE_URL      API root (default: http://localhost:4000/api/v1)
 *   WORKSPACE_ID  Target workspace UUID (optional; resolved in setup)
 *   AGENT_ID      Agent UUID for compliance checks (optional; first agent used)
 *   AUTH_TOKEN    Bearer token (optional)
 *   AUTH_EMAIL    Session auth email (optional)
 *   AUTH_PASSWORD Session auth password (optional)
 *
 * Thresholds:
 *   http_req_duration.p(95) < 1.5 s  — generous for compliance DB writes
 *   http_req_failed.rate    < 1%     — compliance must never silently fail
 *   custom_errors.rate        < 1%
 *
 * Run:
 *   k6 run k6/compliance-load.js
 *   k6 run k6/compliance-load.js -e BASE_URL=https://api.yourdomain.com -e AUTH_TOKEN=xxx
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const AUTH_EMAIL = __ENV.AUTH_EMAIL || `k6-compliance-${Date.now()}@voiceforge.test`;
const AUTH_PASSWORD = __ENV.AUTH_PASSWORD || 'LoadTest123!';
const WORKSPACE_ID = __ENV.WORKSPACE_ID;
const AGENT_ID = __ENV.AGENT_ID;

const customErrorRate = new Rate('custom_errors');
const compliancePassed = new Counter('compliance_checks_passed');
const complianceBlocked = new Counter('compliance_checks_blocked');
const complianceLatency = new Trend('compliance_check_latency');

export const options = {
  stages: [
    { duration: '1m', target: 10 },   // ramp to 10 VUs
    { duration: '3m', target: 10 },   // steady compliance load
    { duration: '30s', target: 0 },   // cool-down
  ],
  thresholds: {
    // Compliance writes (contact upserts, consent grants, DNC inserts)
    // can be heavier than reads; allow up to 1.5 s at the 95th percentile.
    http_req_duration: ['p(95)<1500'],
    // Any failure rate > 1 % is unacceptable for compliance paths because
    // a missed opt-out or failed consent write has legal implications.
    http_req_failed: ['rate<0.01'],
    custom_errors: ['rate<0.01'],
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
  if (AUTH_TOKEN && WORKSPACE_ID && AGENT_ID) {
    return { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, cookies: null };
  }

  const jar = new http.CookieJar();
  const jsonHeaders = { 'Content-Type': 'application/json' };

  const signupRes = http.post(
    `${BASE_URL}/auth/signup`,
    JSON.stringify({
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
      name: 'k6 Compliance Test',
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

  if (!workspaceId) {
    console.warn('WARN: No workspace resolved. Set WORKSPACE_ID env var.');
  }
  if (!agentId) {
    console.warn('WARN: No agent resolved. Set AGENT_ID env var.');
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

/**
 * Generate a unique phone number for this VU and iteration so that
 * concurrent VUs do not collide on the unique phone constraint.
 */
function uniquePhone(vu, iter) {
  // E.164-ish format; prefix 555 avoids real number collisions.
  return `+1555${String(vu).padStart(3, '0')}${String(iter % 10000).padStart(4, '0')}`;
}

export default function (data) {
  const ws = data.workspaceId || WORKSPACE_ID;
  const agentId = data.agentId || AGENT_ID;
  if (!ws || !agentId) {
    console.warn('WARN: missing workspaceId or agentId; skipping iteration.');
    sleep(1);
    return;
  }

  const cfg = baseConfig(data);
  const vu = __VU;
  const iter = __ITER;

  // ── 0. Discovery reads ──
  // Baseline read latency for contact and DNC indexes.
  const contactsListRes = http.get(`${BASE_URL}/workspaces/${ws}/contacts`, cfg);
  check(contactsListRes, {
    'GET contacts returns 200': (r) => r.status === 200,
    'GET contacts returns items': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).items);
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(contactsListRes.status >= 400 ? 1 : 0);

  const dncListRes = http.get(`${BASE_URL}/workspaces/${ws}/compliance/dnc`, cfg);
  check(dncListRes, {
    'GET dnc returns 200': (r) => r.status === 200,
    'GET dnc returns items': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).items);
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(dncListRes.status >= 400 ? 1 : 0);

  // ── 1. Create (upsert) a contact ──
  // Simulates a CRM import or web-form submission.
  const phone = uniquePhone(vu, iter);
  const createPayload = JSON.stringify({
    phone,
    email: `vu${vu}-iter${iter}@voiceforge.test`,
    full_name: `Load Test Contact ${vu}/${iter}`,
    metadata: { source: 'k6', iteration: String(iter) },
  });
  const createRes = http.post(
    `${BASE_URL}/workspaces/${ws}/contacts`,
    createPayload,
    cfg
  );
  check(createRes, {
    'POST contacts returns 200 or 201': (r) => r.status === 200 || r.status === 201,
    'POST contacts returns contact JSON': (r) => {
      try {
        return JSON.parse(r.body).id !== undefined;
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(createRes.status >= 400 ? 1 : 0);

  let contactId;
  try {
    contactId = JSON.parse(createRes.body).id;
  } catch (_e) {
    // If creation failed, skip dependent steps.
    sleep(1);
    return;
  }

  // ── 2. Retrieve contact ──
  // Validates read-after-write consistency.
  const getRes = http.get(
    `${BASE_URL}/workspaces/${ws}/contacts/${contactId}`,
    cfg
  );
  check(getRes, {
    'GET contact by id returns 200': (r) => r.status === 200,
    'GET contact phone matches': (r) => {
      try {
        return JSON.parse(r.body).phone === phone;
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(getRes.status >= 400 ? 1 : 0);

  // ── 3. Update contact metadata ──
  // Simulates a support agent adding notes.
  const patchPayload = JSON.stringify({
    full_name: `Updated Contact ${vu}/${iter}`,
    metadata: { note: 'Updated during k6 compliance load test' },
  });
  const patchRes = http.patch(
    `${BASE_URL}/workspaces/${ws}/contacts/${contactId}`,
    patchPayload,
    cfg
  );
  check(patchRes, {
    'PATCH contact returns 200': (r) => r.status === 200,
  });
  customErrorRate.add(patchRes.status >= 400 ? 1 : 0);

  // ── 4. Grant consent ──
  // Without consent, outbound compliance checks block the call.
  const consentPayload = JSON.stringify({
    consent_type: 'outbound_marketing',
    source: 'api',
    metadata: { granted_during: 'k6_load_test' },
  });
  const consentRes = http.post(
    `${BASE_URL}/workspaces/${ws}/contacts/${contactId}/consent`,
    consentPayload,
    cfg
  );
  check(consentRes, {
    'POST consent returns 200': (r) => r.status === 200,
  });
  customErrorRate.add(consentRes.status >= 400 ? 1 : 0);

  // ── 5. Compliance check ──
  // This is the gatekeeper: every outbound call must pass it.
  // With consent granted, we expect a 'passed' status.
  const checkPayload = JSON.stringify({
    agent_id: agentId,
    direction: 'outbound',
    to_number: phone,
    contact_id: contactId,
    purpose: 'appointment_reminder',
  });
  const checkStart = Date.now();
  const checkRes = http.post(
    `${BASE_URL}/workspaces/${ws}/compliance/check`,
    checkPayload,
    cfg
  );
  complianceLatency.add(Date.now() - checkStart);
  check(checkRes, {
    'POST compliance/check returns 200': (r) => r.status === 200,
    'POST compliance/check returns status': (r) => {
      try {
        return JSON.parse(r.body).status !== undefined;
      } catch {
        return false;
      }
    },
  });
  customErrorRate.add(checkRes.status >= 400 ? 1 : 0);

  try {
    const checkBody = JSON.parse(checkRes.body);
    if (checkBody.status === 'passed') {
      compliancePassed.add(1);
    } else if (checkBody.status === 'blocked') {
      complianceBlocked.add(1);
    }
  } catch (_e) {
    /* ignore */
  }

  // ── 6. Add DNC entry (different number) ──
  // Simulates an opt-out request arriving from another channel.
  const dncPhone = `+1555${String(vu).padStart(3, '0')}9${String(iter % 1000).padStart(3, '0')}`;
  const dncPayload = JSON.stringify({
    phone: dncPhone,
    source: 'manual',
    reason: 'k6 load test opt-out simulation',
  });
  const dncRes = http.post(
    `${BASE_URL}/workspaces/${ws}/compliance/dnc`,
    dncPayload,
    cfg
  );
  check(dncRes, {
    'POST dnc returns 200 or 201': (r) => r.status === 200 || r.status === 201,
  });
  customErrorRate.add(dncRes.status >= 400 ? 1 : 0);

  // ── 7. Final discovery read ──
  // After all writes, ensure list endpoints still respond quickly
  // and return coherent data.
  const finalListRes = http.get(`${BASE_URL}/workspaces/${ws}/contacts`, cfg);
  check(finalListRes, {
    'Final GET contacts returns 200': (r) => r.status === 200,
  });
  customErrorRate.add(finalListRes.status >= 400 ? 1 : 0);

  sleep(1);
}
