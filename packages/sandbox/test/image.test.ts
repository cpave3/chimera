import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeSandboxBuildContext } from '../src/build-context';
import { defaultImageRef, isLocalDevImage } from '../src/image';

describe('the default sandbox image', () => {
  it('is the published image of a release, tagged with its version', () => {
    expect(defaultImageRef('v1.2.3')).toBe('ghcr.io/cpave3/chimera-sandbox:v1.2.3');
    expect(isLocalDevImage(defaultImageRef('v1.2.3'))).toBe(false);
  });

  it('is the local image for a build from source or a prerelease', () => {
    expect(defaultImageRef('dev')).toBe('chimera-sandbox:dev');
    expect(defaultImageRef('v1.2.3-rc.1')).toBe('chimera-sandbox:dev');
  });
});

describe('writeSandboxBuildContext', () => {
  it('writes the embedded Dockerfile and an executable entrypoint to a new directory', () => {
    const dir = writeSandboxBuildContext();
    try {
      const shipped = join(import.meta.dirname, '..', 'docker');
      expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).toBe(
        readFileSync(join(shipped, 'Dockerfile'), 'utf8'),
      );
      expect(readFileSync(join(dir, 'entrypoint.sh'), 'utf8')).toBe(
        readFileSync(join(shipped, 'entrypoint.sh'), 'utf8'),
      );
      expect(statSync(join(dir, 'entrypoint.sh')).mode & 0o111).not.toBe(0);
      expect(writeSandboxBuildContext()).not.toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
