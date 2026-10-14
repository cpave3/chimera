import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChimera } from '../src/run-chimera';

const FAKE_CHIMERA = [
  process.execPath,
  fileURLToPath(new URL('./fixtures/fake-chimera.mjs', import.meta.url)),
];

describe('runChimera', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'chimera-evals-run-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function run(scenario: string, timeoutMs = 10_000) {
    vi.stubEnv('FAKE_CHIMERA_SCENARIO', scenario);
    return runChimera({
      command: FAKE_CHIMERA,
      cwd: directory,
      home: join(directory, 'home'),
      flags: ['--model', 'lm-studio/some-model'],
      prompt: 'Change the timeout.',
      maxSteps: 30,
      timeoutMs,
    });
  }

  it('starts a JSON run in the workspace with the eval home, and returns its events', async () => {
    const result = await run('echo');

    expect(result.exitCode).toBe(0);
    expect(result.stopped).toBeUndefined();
    expect(result.events.map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_start',
      'run_finished',
    ]);
    const echoed = result.events[1] as { args: { argv: string[]; home: string; cwd: string } };
    expect(echoed.args).toEqual({
      argv: [
        'run',
        '--json',
        '--max-steps',
        '30',
        '--model',
        'lm-studio/some-model',
        'Change the timeout.',
      ],
      home: join(directory, 'home'),
      cwd: directory,
    });
    expect(result.stderr).toContain('a warning on stderr');
  });

  it('stops a run that asks for a permission, because nobody can answer', async () => {
    const result = await run('permission');

    expect(result.stopped).toBe('permission');
    expect(result.events.at(-1)).toMatchObject({
      type: 'permission_request',
      command: 'sudo rm -rf /',
    });
  });

  it('does not wait for a process that the run left behind', async () => {
    const result = await run('leave-process');

    expect(result.exitCode).toBe(0);
    expect(result.stopped).toBeUndefined();
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('stops a run that goes past the time limit', async () => {
    const result = await run('hang', 200);

    expect(result.stopped).toBe('timeout');
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
