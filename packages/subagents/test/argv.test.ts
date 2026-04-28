import { describe, expect, it } from 'vitest';
import { buildChildArgv } from '../src/spawn-child';

describe('buildChildArgv', () => {
  it('emits the required flags for a top-level child', () => {
    const argv = buildChildArgv({
      chimeraBin: 'chimera',
      cwd: '/tmp/proj',
      parentSessionId: 'parent-1',
      autoApprove: 'host',
      sandbox: false,
      parentHasTty: true,
    });
    expect(argv).toContain('serve');
    expect(argv).toContain('--machine-handshake');
    expect(argv).toContain('--cwd');
    expect(argv[argv.indexOf('--cwd') + 1]).toBe('/tmp/proj');
    expect(argv).toContain('--parent');
    expect(argv[argv.indexOf('--parent') + 1]).toBe('parent-1');
    expect(argv).toContain('--auto-approve');
    expect(argv[argv.indexOf('--auto-approve') + 1]).toBe('host');
    expect(argv).not.toContain('--sandbox');
  });

  it('forwards sandbox flags when enabled', () => {
    const argv = buildChildArgv({
      chimeraBin: 'chimera',
      cwd: '/p',
      parentSessionId: 'p1',
      autoApprove: 'sandbox',
      sandbox: true,
      sandboxMode: 'overlay',
      parentHasTty: true,
    });
    expect(argv).toContain('--sandbox');
    expect(argv[argv.indexOf('--sandbox-mode') + 1]).toBe('overlay');
  });

  it('forwards model when supplied', () => {
    const argv = buildChildArgv({
      chimeraBin: 'chimera',
      cwd: '/p',
      parentSessionId: 'p1',
      modelRef: 'anthropic/claude-haiku-4-5',
      autoApprove: 'none',
      sandbox: false,
      parentHasTty: true,
    });
    expect(argv[argv.indexOf('--model') + 1]).toBe('anthropic/claude-haiku-4-5');
  });

  it('passes --headless-permission-auto-deny when parent has no TTY', () => {
    const argv = buildChildArgv({
      chimeraBin: 'chimera',
      cwd: '/p',
      parentSessionId: 'p1',
      autoApprove: 'none',
      sandbox: false,
      parentHasTty: false,
    });
    expect(argv).toContain('--headless-permission-auto-deny');
  });

  it('emits --system-prompt-file when extras supplies one', () => {
    const argv = buildChildArgv(
      {
        chimeraBin: 'chimera',
        cwd: '/p',
        parentSessionId: 'p1',
        autoApprove: 'host',
        sandbox: false,
        parentHasTty: true,
      },
      { systemPromptFile: '/tmp/sp.txt' },
    );
    expect(argv[argv.indexOf('--system-prompt-file') + 1]).toBe('/tmp/sp.txt');
  });

  it('emits --tools as a CSV when args.tools is supplied', () => {
    const argv = buildChildArgv({
      chimeraBin: 'chimera',
      cwd: '/p',
      parentSessionId: 'p1',
      autoApprove: 'host',
      sandbox: false,
      parentHasTty: true,
      tools: ['read', 'grep', 'glob'],
    });
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep,glob');
  });

  it('omits --tools when the array is empty', () => {
    const argv = buildChildArgv({
      chimeraBin: 'chimera',
      cwd: '/p',
      parentSessionId: 'p1',
      autoApprove: 'host',
      sandbox: false,
      parentHasTty: true,
      tools: [],
    });
    expect(argv).not.toContain('--tools');
  });
});
