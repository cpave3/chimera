import { defineConfig, type Options } from 'tsup';

export const baseConfig: Options = {
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  treeshake: true,
  // Built-in modes, skills and agents ship inside the code: a single binary has no files beside it.
  loader: { '.md': 'text' },
};

export default defineConfig(baseConfig);
