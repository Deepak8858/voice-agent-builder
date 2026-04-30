const fs = require('fs');
const crypto = require('crypto');

const jwtSecret = crypto.randomBytes(32).toString('hex');
const encryptionKey = crypto.randomBytes(32).toString('hex');

let env = fs.readFileSync('.env', 'utf8');

// Runtime mode
env = env.replace(/^NODE_ENV=.*/m, 'NODE_ENV=production');

// Frontend public URLs (baked into web image — also set in .env for reference)
env = env.replace(/^NEXT_PUBLIC_API_URL=.*/m, 'NEXT_PUBLIC_API_URL=https://vocal.devdeepak.me/api/v1');
env = env.replace(/^NEXT_PUBLIC_APP_URL=.*/m, 'NEXT_PUBLIC_APP_URL=https://vocal.devdeepak.me');

// Internal API port overrides for VM networking
env = env.replace(/^API_PORT=.*/m, 'API_PORT=4000');
env = env.replace(/^WEB_PORT=.*/m, 'WEB_PORT=3000');

// Redis: docker-compose provides a local redis service
env = env.replace(/^REDIS_URL=.*/m, 'REDIS_URL=redis://redis:6379');

// Security secrets
env = env.replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${jwtSecret}`);
env = env.replace(/^ENCRYPTION_KEY=.*/m, `ENCRYPTION_KEY=${encryptionKey}`);

// Strip exposed/unnecessary tokens from runtime env
env = env.replace(/^GIT_PAT=.*/m, '');

fs.writeFileSync('.env.production', env.trim() + '\n');
console.log('Generated .env.production');
