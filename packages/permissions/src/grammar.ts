import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const GRAMMAR = 'tree-sitter-bash.wasm';

/**
 * The tree-sitter bash grammar: the copy the build puts beside this module
 * (`dist/`, or the root of a single binary, where it is embedded), else the
 * one in the parser package, when this runs from source.
 */
export function bashGrammarPath(moduleDir: string = __dirname): string {
  const beside = join(moduleDir, GRAMMAR);
  if (existsSync(beside)) return beside;
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@aslamplr/pi-safe-shell/package.json')), 'src', GRAMMAR);
}
