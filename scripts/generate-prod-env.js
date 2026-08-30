const fs = require('fs');
const crypto = require('crypto');

let env = fs.readFileSync('.env', 'utf8');

// Never regenerate a secret that already exists. ENCRYPTION_KEY especially: the
// AES-256-GCM envelope written by apps/api/src/security/encryption.service.ts
// carries no key id and resolveKey() loads exactly one key, so replacing the
// value does not re-key anything — it makes every stored ciphertext permanently
// undecryptable, including tenant provider credentials and OAuth tokens.
const existingValue = (name) =>
  new RegExp(`^${name}=(.+)$`, 'm').exec(env)?.[1]?.trim() || null;

const encryptionKey = existingValue('ENCRYPTION_KEY');
if (!encryptionKey) {
  throw new Error(
    'ENCRYPTION_KEY is missing from .env. Set it there first. This script must ' +
      'never generate one: a fresh key orphans every existing ciphertext.',
  );
}

// Rotating JWT_SECRET only invalidates sessions, so inventing one is safe when
// absent — but preserve it when present so re-running this script does not log
// every user out as a side effect.
const jwtSecret = existingValue('JWT_SECRET') ?? crypto.randomBytes(32).toString('hex');

// Runtime mode
env = env.replace(/^NODE_ENV=.*/m, 'NODE_ENV=production');

// Frontend public URLs (baked into web image — also set in .env for reference)
env = env.replace(/^NEXT_PUBLIC_API_URL=.*/m, 'NEXT_PUBLIC_API_URL=https://incfrog.ai/api/v1');
env = env.replace(/^NEXT_PUBLIC_APP_URL=.*/m, 'NEXT_PUBLIC_APP_URL=https://incfrog.ai');

// Internal API port overrides for VM networking
env = env.replace(/^API_PORT=.*/m, 'API_PORT=4000');
env = env.replace(/^WEB_PORT=.*/m, 'WEB_PORT=3000');

// Redis: docker-compose provides a local redis service
env = env.replace(/^REDIS_URL=.*/m, 'REDIS_URL=redis://redis:6379');
if (/^WORKERS_ENABLED=.*/m.test(env)) {
  env = env.replace(/^WORKERS_ENABLED=.*/m, 'WORKERS_ENABLED=true');
} else {
  env = env.replace(/^REDIS_URL=.*/m, 'REDIS_URL=redis://redis:6379\nWORKERS_ENABLED=true');
}

// Security secrets
env = env.replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${jwtSecret}`);
env = env.replace(/^ENCRYPTION_KEY=.*/m, `ENCRYPTION_KEY=${encryptionKey}`);

// Strip exposed/unnecessary tokens from runtime env
env = env.replace(/^GIT_PAT=.*/m, '');

fs.writeFileSync('.env.production', env.trim() + '\n');
console.log('Generated .env.production');
