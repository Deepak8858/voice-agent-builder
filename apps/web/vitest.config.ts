import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      '@voiceforge/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    // Several server/config suites intentionally replace process.env and reset
    // the module graph. Running files concurrently lets those process-global
    // mutations leak across workers and makes disabled analytics tests flaky.
    fileParallelism: false,
  },
});
