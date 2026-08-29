// Default env values for the test environment. Loaded via vitest `setupFiles`
// before any module that imports `src/config/env.ts`. Real values can still
// be supplied through the shell or a real .env at runtime.
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.NODE_ENV ??= 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-with-at-least-32-chars';
// Both are required by src/config/env.ts, which parses eagerly at import time —
// without these, a missing value is a vitest *collection* error, not a test
// failure, and takes down every file that transitively imports the schema.
process.env.INTERNAL_API_KEY ??= 'test-internal-api-key-at-least-32-chars';
process.env.SUPABASE_URL ??= 'https://test-project.supabase.co';
