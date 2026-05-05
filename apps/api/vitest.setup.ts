// Default env values for the test environment. Loaded via vitest `setupFiles`
// before any module that imports `src/config/env.ts`. Real values can still
// be supplied through the shell or a real .env at runtime.
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.NODE_ENV ??= 'test';
