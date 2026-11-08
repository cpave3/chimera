import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const FAKE_SERVER = join(import.meta.dirname, 'fixtures', 'fake-model-server.mjs');
const hasScript = spawnSync('script', ['--version']).status === 0;
const built = existsSync(BIN);

/** Run a command in a pseudo-terminal with util-linux `script`, returning what the terminal got. */
function inPty(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-qfec', command, '/dev/null'], { env, cwd });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(output));
  });
}

describe.skipIf(!hasScript || !built)('chimera run on a terminal', () => {
  let home: string;
  let server: ReturnType<typeof spawn>;
  let port = 0;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-run-tty-'));
    await mkdir(join(home, '.chimera'), { recursive: true });
    await mkdir(join(home, 'work'));
    await writeFile(join(home, 'work', 'notes.txt'), 'one\ntwo\nthree\n');
    await writeFile(
      join(home, 'script.json'),
      JSON.stringify([{ tool: 'read', args: { path: 'notes.txt' } }, { text: 'Read it.' }]),
    );
    server = spawn(process.execPath, [FAKE_SERVER, join(home, 'script.json'), '0']);
    port = await new Promise<number>((resolve) => {
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
  });

  afterAll(async () => {
    server?.kill();
    await rm(home, { recursive: true, force: true });
  });

  it('colours the tool rows with the theme', { timeout: 30_000 }, async () => {
    const output = await inPty(
      `'${process.execPath}' '${BIN}' run 'read the notes'`,
      { ...process.env, HOME: home, TERM: 'xterm-256color', NO_COLOR: '' },
      join(home, 'work'),
    );
    expect(output).toContain('Read it.');
    // The label, then the facts, each in its own colour.
    expect(output).toContain('\x1b[90m   read\x1b[39m  notes.txt  \x1b[');
    expect(output).toContain('m3 lines\x1b[');
  });
});
