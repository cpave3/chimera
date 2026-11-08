import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

export default defineConfig({
  ...baseConfig,
  entry: {
    index: 'src/index.ts',
    bin: 'src/bin.ts',
  },
  format: ['esm'],
  tsconfig: './tsconfig.json',
  // bin.js loads the CLI from the sibling index.js; see src/bin.ts.
  external: ['./index.js'],
});
