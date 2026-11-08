import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dockerfile from '../docker/Dockerfile';
import entrypoint from '../docker/entrypoint.sh';

/**
 * Write the sandbox image's build context (the Dockerfile and entrypoint,
 * embedded in the code) to a new temporary directory, for `docker build`.
 * A single binary has no `docker/` directory on disk.
 */
export function writeSandboxBuildContext(root: string = tmpdir()): string {
  const dir = mkdtempSync(join(root, 'chimera-sandbox-build-'));
  writeFileSync(join(dir, 'Dockerfile'), dockerfile);
  writeFileSync(join(dir, 'entrypoint.sh'), entrypoint);
  chmodSync(join(dir, 'entrypoint.sh'), 0o755);
  return dir;
}
