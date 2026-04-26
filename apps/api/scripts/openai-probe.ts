import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv(): Record<string, string> {
  const envs: Record<string, string> = { ...(process.env as Record<string, string>) };
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '..', '.env'),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/i);
        if (m && !(m[1] in envs)) envs[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      /* missing file is fine */
    }
  }
  return envs;
}

async function main() {
  const env = loadEnv();
  const key = env.OPENAI_API_KEY;
  const model = env.LLM_MODEL ?? 'gpt-4o-mini';
  if (!key) {
    console.error('[openai-probe] OPENAI_API_KEY missing.');
    process.exit(1);
  }

  console.log('[openai-probe] Running...');
  console.log(`  model: ${model}`);
  console.log(`  key  : ${key.slice(0, 7)}…${key.slice(-4)}`);

  const t = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 60,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Reply with a JSON object {"ok": true, "where": "openai"}.' },
        { role: 'user', content: 'ping' },
      ],
    }),
  });
  const ms = Date.now() - t;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`  ✗ HTTP ${res.status} ${res.statusText} (${ms}ms)`);
    console.error(`     ${text.slice(0, 400)}`);
    process.exit(1);
  }

  const json = (await res.json()) as {
    model?: string;
    usage?: Record<string, number>;
    choices?: Array<{ message?: { content?: string } }>;
  };
  console.log(`  ✓ HTTP 200 (${ms}ms) — model=${json.model}`);
  console.log(`  ✓ usage: ${JSON.stringify(json.usage)}`);
  console.log(`  ✓ content: ${json.choices?.[0]?.message?.content}`);
}

main().catch((err) => {
  console.error('[openai-probe] Failed:', err);
  process.exit(1);
});
