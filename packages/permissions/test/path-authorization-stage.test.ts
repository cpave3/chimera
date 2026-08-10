import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathAuthorizationStage } from '../src/path-authorization-stage';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('PathAuthorizationStage', () => {
  it('allows reads in read roots but requires a write grant for the same path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chimera-policy-cwd-'));
    const readRoot = await mkdtemp(join(tmpdir(), 'chimera-policy-read-'));
    cleanup.push(cwd, readRoot);
    const stage = new PathAuthorizationStage();
    const context = {
      command: 'test',
      target: 'host' as const,
      cwd,
      home: '/home/user',
      projectRoot: cwd,
      roots: { read: [cwd, readRoot], write: [cwd] },
      facts: [{ kind: 'shell_effect' as const, operation: 'write' as const, path: readRoot }],
    };

    await expect(
      stage.evaluate({
        ...context,
        facts: [{ kind: 'shell_effect', operation: 'read', path: readRoot }],
      }),
    ).resolves.toEqual({ status: 'pass' });
    await expect(stage.evaluate(context)).resolves.toMatchObject({
      status: 'findings',
      findings: [{ kind: 'path', operation: 'write', requiredGrant: 'write' }],
      grantProposal: { kind: 'write', path: readRoot },
    });
  });

  it('canonicalizes a symlinked parent for a new write target', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'chimera-policy-cwd-'));
    const outside = await mkdtemp(join(tmpdir(), 'chimera-policy-outside-'));
    cleanup.push(cwd, outside);
    const linked = join(cwd, 'linked');
    await symlink(outside, linked);
    const stage = new PathAuthorizationStage();

    const result = await stage.evaluate({
      command: 'echo x > linked/new.txt',
      target: 'host',
      cwd,
      home: '/home/user',
      projectRoot: cwd,
      roots: { read: [cwd], write: [cwd] },
      facts: [{ kind: 'shell_effect', operation: 'write', path: 'linked/new.txt' }],
    });

    expect(result).toMatchObject({
      status: 'findings',
      findings: [{ kind: 'path', resolvedPath: join(outside, 'new.txt') }],
      grantProposal: { kind: 'write', path: outside },
    });
  });
});
