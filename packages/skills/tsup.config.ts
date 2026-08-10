import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  tsconfig: './tsconfig.json',
  async onSuccess() {
    const packageDir = dirname(fileURLToPath(import.meta.url));
    await mkdir(join(packageDir, 'dist/builtin'), { recursive: true });
    await cp(join(packageDir, 'builtin'), join(packageDir, 'dist/builtin'), { recursive: true });
  },
});
