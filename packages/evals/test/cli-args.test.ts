import { describe, expect, it } from 'vitest';
import { parseCli } from '../src/cli-args';
import { VARIANTS } from '../src/variants';

describe('parseCli', () => {
  it('runs with the defaults when only the command is given', () => {
    expect(parseCli(['run'])).toEqual({ command: 'run', input: {}, keepLoaded: false });
  });

  it('reads the choices of a run', () => {
    const parsed = parseCli([
      'run',
      '--models',
      'qwen3.5-9b,google/gemma-4-12b-qat',
      '--variants',
      'guided,lean',
      '--tasks',
      'edit,fix-*',
      '--trials',
      '5',
      '--context',
      '16384',
      '--max-steps',
      '20',
      '--timeout',
      '120',
      '--base-url',
      'http://192.168.1.166:1234/v1',
      '--chimera',
      '/usr/local/bin/chimera',
      '--no-load',
      '--keep-loaded',
    ]);

    expect(parsed).toEqual({
      command: 'run',
      keepLoaded: true,
      input: {
        models: ['qwen3.5-9b', 'google/gemma-4-12b-qat'],
        variants: ['guided', 'lean'],
        tasks: ['edit', 'fix-*'],
        trials: 5,
        contextWindow: 16_384,
        maxSteps: 20,
        timeoutSeconds: 120,
        baseUrl: 'http://192.168.1.166:1234/v1',
        chimeraCommand: ['/usr/local/bin/chimera'],
        manageModels: false,
      },
    });
  });

  it('takes "all" as every variant', () => {
    const parsed = parseCli(['run', '--variants', 'all']);

    expect(parsed).toMatchObject({ input: { variants: VARIANTS.map((variant) => variant.id) } });
  });

  it('rejects a number that is not a positive whole number', () => {
    expect(() => parseCli(['run', '--trials', 'many'])).toThrow(
      '--trials must be a whole number above 0',
    );
  });

  it('reads the file of a report and the port of the UI', () => {
    expect(parseCli(['report', 'old-run.json'])).toEqual({
      command: 'report',
      file: 'old-run.json',
    });
    expect(parseCli(['report'])).toEqual({ command: 'report', file: undefined });
    expect(parseCli(['ui', '--port', '4000'])).toEqual({ command: 'ui', port: 4000 });
    expect(parseCli(['ui'])).toEqual({ command: 'ui', port: 3006 });
    expect(parseCli(['list'])).toEqual({ command: 'list' });
  });

  it('shows the help for no command, --help and an unknown command', () => {
    expect(parseCli([])).toEqual({ command: 'help' });
    expect(parseCli(['run', '--help'])).toEqual({ command: 'help' });
    expect(() => parseCli(['frobnicate'])).toThrow('Unknown command "frobnicate"');
  });
});
