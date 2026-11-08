import { describe, expect, it } from 'vitest';
import { isSingleExecutable, resolveChimeraInvocation } from '../src/factory';

const node = {
  env: {},
  execPath: '/usr/bin/node',
  argv: ['/usr/bin/node', '/opt/chimera/dist/bin.js'],
};

describe('how Chimera starts another copy of itself', () => {
  it('runs the same script through the same node, from a source build', () => {
    expect(isSingleExecutable(node)).toBe(false);
    expect(resolveChimeraInvocation(node)).toEqual({
      bin: '/usr/bin/node',
      preArgs: ['/opt/chimera/dist/bin.js'],
    });
  });

  it('runs the executable itself, with no script, as a single binary', () => {
    const binary = {
      env: {},
      execPath: '/home/me/.local/bin/chimera',
      argv: ['bun', '/$bunfs/root/chimera'],
    };
    expect(isSingleExecutable(binary)).toBe(true);
    expect(resolveChimeraInvocation(binary)).toEqual({
      bin: '/home/me/.local/bin/chimera',
      preArgs: [],
    });
    expect(
      resolveChimeraInvocation({ ...node, execPath: '/usr/local/bin/chimera', standalone: true }),
    ).toEqual({ bin: '/usr/local/bin/chimera', preArgs: [] });
  });

  it('honours CHIMERA_BIN first', () => {
    expect(
      resolveChimeraInvocation({ ...node, env: { CHIMERA_BIN: '/x/chimera' }, standalone: true }),
    ).toEqual({
      bin: '/x/chimera',
      preArgs: [],
    });
  });
});
