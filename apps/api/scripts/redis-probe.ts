import 'dotenv/config';
import IORedis, { type RedisOptions } from 'ioredis';

const url = process.argv[2] || process.env.REDIS_URL;
if (!url) {
  console.error('Usage: tsx scripts/redis-probe.ts <redis-url>');
  process.exit(2);
}

const options: RedisOptions = {
  connectTimeout: 5_000,
  maxRetriesPerRequest: 2,
  retryStrategy: () => null, // fail fast
  lazyConnect: true,
};

try {
  const parsed = new URL(url);
  if (parsed.protocol === 'rediss:') {
    options.tls = { servername: parsed.hostname };
  }
} catch {
  /* ignore */
}

const client = new IORedis(url, options);
const start = Date.now();

(async () => {
  try {
    await client.connect();
    const pong = await client.ping();
    const connectMs = Date.now() - start;

    const testKey = `vf:probe:${Date.now()}`;
    await client.set(testKey, 'hello', 'EX', 30);
    const got = await client.get(testKey);
    await client.del(testKey);

    let info = '';
    try {
      info = (await client.info('server')).split('\n').slice(0, 8).join('\n');
    } catch {
      /* some proxies block INFO */
    }

    console.log('\n[PROBE] SUCCESS');
    console.log(`  endpoint      : ${url.replace(/:[^@/]*@/, ':***@')}`);
    console.log(`  connect+ping  : ${connectMs} ms`);
    console.log(`  ping reply    : ${pong}`);
    console.log(`  set/get/del   : ok (round-tripped '${got}')`);
    if (info) console.log('  INFO server   :\n' + info.replace(/^/gm, '    '));
    process.exit(0);
  } catch (err) {
    console.error('\n[PROBE] FAILED');
    console.error('  endpoint   :', url.replace(/:[^@/]*@/, ':***@'));
    console.error('  error      :', (err as Error).message);
    process.exit(1);
  } finally {
    client.disconnect();
  }
})();
