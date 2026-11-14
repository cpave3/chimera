import { defineConfig } from 'vitest/config';
import { textImports } from '../../vitest.text-imports';

export default defineConfig({
  plugins: [textImports()],
  test: {
    setupFiles: ['../../vitest.isolation.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
