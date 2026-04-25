import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Absolute path to the directory containing the sandbox Dockerfile, resolved
 * relative to this package's compiled output. The package ships `docker/`
 * alongside `dist/` (see `files` in package.json), so `../docker` works for
 * both ESM and CJS builds.
 */
export function sandboxDockerDir(): string {
  // import.meta.url resolves to .../packages/sandbox/dist/index.js at runtime.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'docker');
}
