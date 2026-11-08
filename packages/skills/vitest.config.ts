import { defineConfig } from 'vitest/config';
import { markdownAsText } from '../../vitest.markdown-text';

export default defineConfig({
  plugins: [markdownAsText()],
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
