import { describe, expect, it } from 'vitest';
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
    const stage = new ShellEffectsStage();

    await expect(stage.evaluate({ ...context, command: 'cat README.md' })).resolves.toEqual({
      status: 'pass',
      facts: [{ kind: 'shell_effect', operation: 'read', path: 'README.md' }],
    });
    await expect(stage.evaluate({ ...context, command: 'echo x > /tmp/output' })).resolves.toEqual({
      status: 'pass',
      facts: [{ kind: 'shell_effect', operation: 'write', path: '/tmp/output' }],
    });
  });

  it('requires approval for dynamic paths and unsupported executables', async () => {
    const stage = new ShellEffectsStage();

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
