const fs = require('fs');
const path = require('path');

const root = process.cwd();
const rootEnv = path.join(root, '.env');
const apiEnv = path.join(root, 'apps', 'api', '.env');
const webEnvLocal = path.join(root, 'apps', 'web', '.env.local');

const REQUIRED_VARS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'CLERK_SECRET_KEY',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_APP_URL',
  'REDIS_URL',
];

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function hasRealValue(val) {
  if (!val) return false;
  if (val.includes('<project-ref>') || val.includes('<password>') || val.includes('YOUR_')) return false;
  return true;
}

const rootVars = readEnvFile(rootEnv);
const apiVars = readEnvFile(apiEnv);
const webVars = readEnvFile(webEnvLocal);

let exitCode = 0;

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║     VoiceForge AI — Environment Variable Audit             ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Check root .env
console.log('📄 Root .env');
for (const key of REQUIRED_VARS) {
  const ok = hasRealValue(rootVars[key]);
  console.log(`   ${ok ? '✅' : '❌'} ${key}: ${ok ? 'set' : 'MISSING or placeholder'}`);
  if (!ok) exitCode = 1;
}

// Check api .env
console.log('\n📄 apps/api/.env');
for (const key of REQUIRED_VARS) {
  const ok = hasRealValue(apiVars[key]);
  console.log(`   ${ok ? '✅' : '❌'} ${key}: ${ok ? 'set' : 'MISSING or placeholder'}`);
  if (!ok) exitCode = 1;
}

// Check web .env.local
console.log('\n📄 apps/web/.env.local');
const WEB_KEYS = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'];
for (const key of WEB_KEYS) {
  const ok = hasRealValue(webVars[key]);
  console.log(`   ${ok ? '✅' : '❌'} ${key}: ${ok ? 'set' : 'MISSING or placeholder'}`);
  if (!ok) exitCode = 1;
}

// Check NEXT_PUBLIC_API_URL suffix
console.log('\n🔗 URL Consistency Check');
const urls = [
  { name: 'root .env', val: rootVars['NEXT_PUBLIC_API_URL'] },
  { name: 'api .env', val: apiVars['NEXT_PUBLIC_API_URL'] },
  { name: 'web .env.local', val: webVars['NEXT_PUBLIC_API_URL'] },
];
for (const u of urls) {
  const hasPrefix = u.val?.endsWith('/api/v1');
  console.log(`   ${hasPrefix ? '✅' : '⚠️'}  ${u.name}: ${u.val || 'missing'} ${hasPrefix ? '' : '(should end with /api/v1)'}`);
}

// Auto-fix option
console.log('\n────────────────────────────────────────────────────────────');
if (exitCode !== 0) {
  console.log('⚠️  Some env files are missing real values or have placeholders.\n');
  console.log('💡 Auto-fix: copy root .env real values into app env files?');
  console.log('   Run:  node scripts/verify-and-fix-env.js --fix\n');
} else {
  console.log('✅ All required env variables look good!\n');
}

// --fix mode
if (process.argv.includes('--fix')) {
  console.log('🔧 Applying fixes...\n');

  function buildEnvContent(vars, keys, extra = []) {
    const lines = [];
    for (const k of [...keys, ...extra]) {
      if (rootVars[k] !== undefined) {
        lines.push(`${k}=${rootVars[k]}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  // Fix apps/api/.env
  const apiContent = buildEnvContent(rootVars, REQUIRED_VARS, ['NODE_ENV', 'API_PORT', 'WEB_PORT', 'JWT_SECRET', 'ENCRYPTION_KEY', 'AUTH_PROVIDER', 'VOICE_PROVIDER', 'LLM_PROVIDER']);
  fs.writeFileSync(apiEnv, apiContent);
  console.log('✅ Wrote apps/api/.env');

  // Fix apps/web/.env.local
  const webContent = buildEnvContent(rootVars, WEB_KEYS, ['NEXT_PUBLIC_CLERK_SIGN_IN_URL', 'NEXT_PUBLIC_CLERK_SIGN_UP_URL', 'NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL', 'NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL']);
  fs.writeFileSync(webEnvLocal, webContent);
  console.log('✅ Wrote apps/web/.env.local');

  console.log('\n🎉 Fix complete! Now restart both dev servers:');
  console.log('   Ctrl+C in API terminal, then:  npm run dev -w @voiceforge/api');
  console.log('   Ctrl+C in Web terminal, then:  npm run dev -w @voiceforge/web');
}

process.exit(exitCode);
