import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig sets "jsx": "preserve" because Next owns the JSX transform in the
  // app build. Vitest has no Next pipeline, so it must be told to emit the
  // automatic runtime itself; otherwise every component suite fails with
  // "React is not defined".
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      // Ordered array, not a map: the @voiceforge/ui subpath pattern has to be
      // tried before the bare-package entry, and object aliases give no ordering
      // guarantee.
      {
        find: /^@voiceforge\/ui\/lib\/cn$/,
        replacement: fileURLToPath(new URL('../../packages/ui/src/lib/cn.ts', import.meta.url)),
      },
      // Mirrors the package's own "./*": "./src/*/index.tsx" export. Vite does
      // not apply that wildcard for a workspace package resolved through a
      // symlink, so component suites fail to resolve `@voiceforge/ui/button`
      // even though Next builds it fine.
      {
        find: /^@voiceforge\/ui\/(.+)$/,
        replacement: fileURLToPath(new URL('../../packages/ui/src/', import.meta.url)) + '$1/index.tsx',
      },
      {
        find: /^@voiceforge\/shared$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('./', import.meta.url)) },
    ],
  },
  test: {
    // Node stays the default: all but a handful of suites are pure logic, and
    // several deliberately mutate process.env or reset the module graph, which
    // a DOM environment only slows down. Component suites opt into jsdom by
    // file name instead of flipping the default for the whole project.
    environment: 'node',
    environmentMatchGlobs: [['**/*.dom.test.{ts,tsx}', 'jsdom']],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    // Several server/config suites intentionally replace process.env and reset
    // the module graph. Running files concurrently lets those process-global
    // mutations leak across workers and makes disabled analytics tests flaky.
    fileParallelism: false,
  },
});
