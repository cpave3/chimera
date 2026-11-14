import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');
const fakeServer = join(import.meta.dirname, 'fixtures', 'fake-model-server.mjs');

describe('built chimera run with a dropped prompt', () => {
  let home: string;
  let server: ReturnType<typeof spawn>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-run-drop-'));
    const modDirectory = join(home, '.chimera', 'mods', 'drop-prompt');
    await mkdir(modDirectory, { recursive: true });
    await mkdir(join(home, 'work'));
    await writeFile(join(home, 'script.json'), JSON.stringify([{ text: 'Unexpected model call' }]));
    server = spawn(process.execPath, [fakeServer, join(home, 'script.json'), '0']);
    const port = await new Promise<number>((resolve) => {
      server.stdout!.on('data', (chunk: Buffer) => {
        const match = /listening (\d+)/.exec(chunk.toString());
        if (match) resolve(Number(match[1]));
      });
    });
    await writeFile(
      join(home, '.chimera', 'config.json'),
      JSON.stringify({
        providers: {
          fake: { shape: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x' },
        },
        defaultModel: 'fake/model',
        models: { 'fake/model': { contextWindow: 100_000 } },
        workspaceCheckpoints: false,
      }),
    );
    await writeFile(
      join(modDirectory, 'chimera-mod.json'),
      JSON.stringify({ name: 'drop-prompt', version: '1', apiVersion: 1, module: 'index.mjs' }),
    );
    await writeFile(
      join(modDirectory, 'index.mjs'),
      `export function register(on) {
        on('prompt.submit', () => ({ decision: 'drop', reason: 'Blocked by prompt policy' }));
      }`,
    );
  });

  afterAll(async () => {
    server?.kill();
    await rm(home, { recursive: true, force: true });
  });

  it.each([false, true])('exits nonzero with the drop reason (json=%s)', (json) => {
    const result = spawnSync(
      process.execPath,
      [bin, 'run', 'blocked', ...(json ? ['--json'] : [])],
      {
        cwd: join(home, 'work'),
        env: { ...process.env, HOME: home, CHIMERA_MOD_DIRS: '', NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    if (json) {
      expect(result.stdout.trim().split('\n').map(JSON.parse)).toEqual([
        { type: 'prompt_dropped', reason: 'Blocked by prompt policy' },
      ]);
    } else {
      expect(result.stderr).toContain('prompt dropped: Blocked by prompt policy');
      expect(result.stdout).toBe('');
    }
    expect(result.stdout).not.toContain('run_finished');
    expect(result.stdout).not.toContain('Unexpected model call');
  });
});
