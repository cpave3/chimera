import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

export default defineConfig({
  ...baseConfig,
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
  tsconfig: './tsconfig.json',
});
