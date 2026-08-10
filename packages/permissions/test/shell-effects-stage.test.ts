import { describe, expect, it } from 'vitest';
import { PiSafeShellAdapter } from '../src/pi-safe-shell-adapter';
import { ShellEffectsStage } from '../src/shell-effects-stage';

const context = {
  target: 'host' as const,
  cwd: '/workspace',
  home: '/home/user',
  projectRoot: '/workspace',
  roots: { read: ['/workspace'], write: ['/workspace'] },
  facts: [],
};

describe('ShellEffectsStage', () => {
  it('emits Chimera-owned read and redirect-write facts for literal operands', async () => {
    const stage = new ShellEffectsStage(new PiSafeShellAdapter());

    await expect(stage.evaluate({ ...context, command: 'cat README.md' })).resolves.toEqual({
      status: 'pass',
      facts: [{ kind: 'shell_effect', operation: 'read', path: 'README.md' }],
    });
    await expect(stage.evaluate({ ...context, command: 'echo x > /tmp/output' })).resolves.toEqual({
      status: 'pass',
      facts: [{ kind: 'shell_effect', operation: 'write', path: '/tmp/output' }],
    });
  });

  it('requires approval for compounds, multiple redirects, and mutating git', async () => {
    const stage = new ShellEffectsStage(new PiSafeShellAdapter());

    for (const command of [
      'echo ok; ./unknown-script',
      'echo x > /etc/passwd > safe-file',
      'git clean -fd',
      'git -C /outside status',
    ]) {
      await expect(stage.evaluate({ ...context, command })).resolves.toMatchObject({
        status: 'findings',
        findings: [{ kind: 'unresolved', stageId: 'shell_effects' }],
      });
    }
  });

  it('requires approval for dynamic paths and unsupported executables', async () => {
    const stage = new ShellEffectsStage(new PiSafeShellAdapter());

    await expect(stage.evaluate({ ...context, command: 'cat "$TARGET"' })).resolves.toMatchObject({
      status: 'findings',
      findings: [{ kind: 'unresolved', stageId: 'shell_effects' }],
    });
    await expect(stage.evaluate({ ...context, command: './script.sh' })).resolves.toMatchObject({
      status: 'findings',
      findings: [{ kind: 'unresolved', stageId: 'shell_effects' }],
    });
  });
});
