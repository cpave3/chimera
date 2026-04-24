import { defineConfig, type Options } from 'tsup';

export const baseConfig: Options = {
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  treeshake: true,
};

export default defineConfig(baseConfig);
