const Redis = require('ioredis');

const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

async function main() {
  console.log(`Checking Redis at: ${url.replace(/:\/\/[^:]+@/, '://***@')}\n`);

  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    retryStrategy: () => null, // fail fast
  });

  redis.on('error', (err) => {
    console.log('❌ Redis connection error:', err.message);
    process.exit(1);
  });

  try {
    const pong = await redis.ping();
    console.log(`   Redis PING: ${pong === 'PONG' ? '✅ PONG' : '❌ ' + pong}`);

    await redis.set('voiceforge:test', 'ok', 'EX', 10);
    const val = await redis.get('voiceforge:test');
    console.log(`   Read/Write: ${val === 'ok' ? '✅ OK' : '❌ FAILED'}`);

    const info = await redis.info('server');
    const version = info.match(/redis_version:(.+)/)?.[1]?.trim();
    console.log(`   Version:    ${version || 'unknown'}`);

    console.log('\n✅ Redis is working properly.\n');
    process.exit(0);
  } catch (err) {
    console.log('\n❌ Redis check failed:', err.message);
    console.log('\nTroubleshooting:');
    console.log('  1. Is Redis running?  redis-cli ping');
    console.log('  2. Is REDIS_URL correct in .env?');
    console.log('  3. If using Docker:  docker compose -f docker-compose.prod.yml up -d redis');
    process.exit(1);
  } finally {
    redis.disconnect();
  }
}

main();
