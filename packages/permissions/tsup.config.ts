import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Options } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

const packageDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const grammarSource = join(
  dirname(require.resolve('@aslamplr/pi-safe-shell/package.json')),
  'src/tree-sitter-bash.wasm',
);

async function copyGrammar(): Promise<void> {
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await copyFile(grammarSource, join(packageDir, 'dist/tree-sitter-bash.wasm'));
}

const shared: Options = {
  ...baseConfig,
  entry: ['src/index.ts'],
  noExternal: ['@aslamplr/pi-safe-shell'],
  external: ['web-tree-sitter'],
  esbuildOptions(options) {
    options.define = { ...options.define, __dirname: '__chimeraPermissionsDirname' };
  },
  onSuccess: copyGrammar,
};

export default defineConfig([
  {
    ...shared,
    format: ['esm'],
    clean: true,
    banner: {
      js: "import { dirname as __chimeraDirname } from 'node:path'; import { fileURLToPath as __chimeraFileURLToPath } from 'node:url'; const __chimeraPermissionsDirname = __chimeraDirname(__chimeraFileURLToPath(import.meta.url));",
    },
  },
  {
    ...shared,
    format: ['cjs'],
    clean: false,
    banner: { js: 'const __chimeraPermissionsDirname = __dirname;' },
  },
]);
