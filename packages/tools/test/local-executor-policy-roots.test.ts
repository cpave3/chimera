import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalExecutor } from '../src/local-executor';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LocalExecutor command policy roots', () => {
  it('returns canonical immutable roots and treats write roots as readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chimera-policy-roots-'));
    cleanup.push(root);
    const realRead = join(root, 'real-read');
    const linkedRead = join(root, 'linked-read');
    const write = join(root, 'write');
    await mkdir(realRead);
    await mkdir(write);
    await symlink(realRead, linkedRead);
    const executor = new LocalExecutor({
      cwd: root,
      readAllowDirs: [linkedRead],
      writeAllowDirs: [write],
    });

    const roots = executor.commandPolicyRoots();

    expect(roots.read).toEqual([root, realRead, write]);
    expect(roots.write).toEqual([root, write]);
    expect(() => roots.read.push('/escape')).toThrow();
  });
});
