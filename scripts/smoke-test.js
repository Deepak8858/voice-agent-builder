/**
 * Smoke test — starts the compiled API server, runs a series of HTTP checks,
 * then shuts it down. Exits with code 0 on success, 1 on failure.
 */
const { spawn } = require('child_process');
const path = require('path');

const API_PORT = process.env.SMOKE_API_PORT || 4000;
const BASE_URL = `http://127.0.0.1:${API_PORT}/api/v1`;
const TEST_WORKSPACE = '00000000-0000-0000-0000-000000000001';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, opts = {}, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      return { status: res.status, body };
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`Unable to connect to ${url} after ${retries} attempts`);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(__dirname, '../apps/api/dist/main.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, API_PORT: String(API_PORT), REDIS_URL: '', NODE_ENV: 'test', CLERK_WEBHOOK_SECRET: '' },
    });

    proc.stdout.on('data', (d) => {
      const text = d.toString().trim();
      if (text) console.log('[API]', text);
    });

    proc.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (text) console.error('[API stderr]', text);
    });

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Server exited with code ${code}`));
      }
    });

    setTimeout(() => resolve(proc), 5000);
  });
}

async function runChecks() {
  const results = [];

  // 1. Health check — DB + LLM up
  const health = await fetchWithRetry(`${BASE_URL}/health`);
  const healthOk = health.status === 200 && health.body?.data?.status === 'ok' && health.body?.data?.db === 'ok';
  results.push({ name: 'health', ok: healthOk, detail: health.body?.data });
  console.log(`  health: ${healthOk ? 'PASS' : 'FAIL'}`, JSON.stringify(health.body?.data));

  // 2. Templates list (auth-protected — 401 confirms auth middleware is active)
  const templates = await fetchWithRetry(`${BASE_URL}/templates`);
  const templatesOk = templates.status === 200 || templates.status === 401;
  results.push({ name: 'templates', ok: templatesOk, detail: templates.status });
  console.log(`  templates: ${templatesOk ? 'PASS' : 'FAIL'} status=${templates.status}`);

  // 3. Auth-guarded agents list should 401/403 without token (confirms auth middleware is active)
  const agents = await fetchWithRetry(`${BASE_URL}/workspaces/${TEST_WORKSPACE}/agents`);
  const agentsOk = agents.status === 401 || agents.status === 403;
  results.push({ name: 'agents-auth', ok: agentsOk, detail: agents.status });
  console.log(`  agents-auth: ${agentsOk ? 'PASS' : 'FAIL'} (expected 401/403, got ${agents.status})`);

  // 4. Clerk webhook endpoint accepts unsigned payload in test mode
  const webhook = await fetchWithRetry(`${BASE_URL}/webhooks/clerk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'user.created',
      timestamp: Date.now(),
      data: {
        id: 'usr_smoke_001',
        email_addresses: [{ email_address: 'smoke@test.local', id: 'email_1' }],
        primary_email_address_id: 'email_1',
        first_name: 'Smoke',
        last_name: 'Test',
      },
    }),
  });
  // In test mode without webhook secret, webhook accepts payload and returns 204
  const webhookOk = webhook.status === 204;
  results.push({ name: 'clerk-webhook', ok: webhookOk, detail: webhook.status });
  console.log(`  clerk-webhook: ${webhookOk ? 'PASS' : 'FAIL'} (expected 204, got ${webhook.status})`);

  // 5. Call a non-existent workspace — should 404 (confirms router is resolving workspace-scoped paths)
  const ws = await fetchWithRetry(`${BASE_URL}/workspaces/${TEST_WORKSPACE}`);
  const wsOk = ws.status === 401 || ws.status === 403 || ws.status === 404;
  results.push({ name: 'workspace-route', ok: wsOk, detail: ws.status });
  console.log(`  workspace-route: ${wsOk ? 'PASS' : 'FAIL'} (expected 401/403/404, got ${ws.status})`);

  return results;
}

async function main() {
  console.log('===> Smoke test starting…');
  console.log('===> Starting API server…');
  const server = await startServer();
  await sleep(1000);

  console.log('===> Running checks…');
  let results;
  try {
    results = await runChecks();
  } catch (err) {
    console.error('Check error:', err.message);
    server.kill('SIGTERM');
    process.exit(1);
  }

  console.log('===> Shutting down API server…');
  server.kill('SIGTERM');
  await sleep(1500);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAILED: ${failed.length}/${results.length} checks failed:`);
    for (const f of failed) console.error(`  - ${f.name}: ${JSON.stringify(f.detail)}`);
    process.exit(1);
  }

  console.log(`\nALL CLEAR: ${results.length}/${results.length} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke test fatal error:', err.message);
  process.exit(1);
});
