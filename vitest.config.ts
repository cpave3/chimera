import { defineConfig } from 'vitest/config';
import { textImports } from './vitest.text-imports';

export default defineConfig({
  plugins: [textImports(/\.md$|docker[/\\](Dockerfile|entrypoint\.sh)$/)],
  test: {
    setupFiles: ['./vitest.isolation.ts'],
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.tsx',
      'packages/*/src/**/*.test.ts',
    ],
    environment: 'node',
  },
});
