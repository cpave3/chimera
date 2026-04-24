import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  format: ['esm'],
  tsconfig: './tsconfig.json',
  dts: {
    compilerOptions: {
      jsx: 'react-jsx',
    },
  },
});
